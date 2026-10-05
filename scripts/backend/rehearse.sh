#!/usr/bin/env bash
set -euo pipefail

# This script starts a database ONLY on an ephemeral GitHub-hosted cloud runner.
if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_ENVIRONMENT:-} != github-hosted || $(uname -s) != Linux ]]; then
  echo 'Cloud rehearsal requires an ephemeral GitHub-hosted Linux runner.' >&2
  exit 1
fi
if [[ $# != 2 || ! $1 =~ ^[a-f0-9]{40}$ || ! $2 =~ ^[a-f0-9]{64}$ ]]; then
  echo 'Supply the exact checkout revision and reviewed rehearsal digest.' >&2
  exit 1
fi
if [[ $(git rev-parse HEAD) != "$1" ]]; then
  echo 'Checkout revision changed.' >&2
  exit 1
fi
node scripts/backend/plan.mjs verify "$1" synthetic-github-runner "$RUNNER_TEMP/u1-plan.json" "$2"
cleanup() {
  supabase stop --project-id still-app --no-backup >/dev/null 2>&1 || return 1
}
trap cleanup EXIT
supabase start --exclude gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor >/dev/null
supabase db reset --local --no-seed >/dev/null
# Local socket in this disposable CLOUD container only. Create a generic fixture login for event
# trigger DDL and selected creator-default hardening. This explicitly privileged synthetic
# administrator is separate from non-superuser application/admin tests; production authority
# remains unproven. No postgres elevation or additional creator membership is installed.
bootstrap_fixture() {
  docker exec -i supabase_db_still-app psql -U supabase_admin -d postgres -X --set=ON_ERROR_STOP=1 <<'SQL'
do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'u1_catalog_fixture') then
    create role u1_catalog_fixture login superuser password 'u1-synthetic-fixture-only';
  end if;
end $$;
SQL
}
bootstrap_fixture
export STILL_SECURITY_TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'
# One environment permission for every database test: driver PG* defaults plus each test's inputs.
db_test_env=--allow-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT,STILL_SECURITY_TEST_DATABASE_URL,STILL_GRANTS_TEST_DATABASE_URL,STILL_GRANTS_TEST_MODE,STILL_GRANTS_GATEWAY_PASSWORD,STILL_U3_MIGRATION_TEST_DATABASE_URL,STILL_U3_MIGRATION_TEST_MODE,STILL_U6_POLICY_TEST_DATABASE_URL,STILL_U6_POLICY_TEST_MODE,PGSSL,PGSSLNEGOTIATION,PGIDLE_TIMEOUT,PGCONNECT_TIMEOUT,PGMAX_LIFETIME,PGMAX_PIPELINE,PGBACKOFF,PGKEEP_ALIVE,PGDEBUG,PGFETCH_TYPES,PGPUBLICATIONS,PGTARGET_SESSION_ATTRS,PGTARGETSESSIONATTRS,PGAPPNAME
deno test --config supabase/functions/deno.json "$db_test_env" --allow-read=scripts/backend/sql --allow-net=127.0.0.1:54322 supabase/tests/security_foundation_test.ts
supabase db reset --local --no-seed >/dev/null
# The reset removed the first test's candidates. Reinstall them atomically so pgTAP proves
# cross-account isolation against the hardened state, with extension-only test helper grants.
bootstrap_fixture
psql "$STILL_SECURITY_TEST_DATABASE_URL" -X --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/catalog-reconciliation.sql
# Match the Deno path: only the declared synthetic administrator applies hardening.
PGPASSWORD='u1-synthetic-fixture-only' psql -h 127.0.0.1 -p 54322 -U u1_catalog_fixture -d postgres -X --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/synthetic-catalog-fixture.sql
psql "$STILL_SECURITY_TEST_DATABASE_URL" -X --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/security-audit-candidate.sql
cat scripts/backend/sql/hardening-candidate.sql scripts/backend/sql/assert-security.sql | \
  PGPASSWORD='u1-synthetic-fixture-only' psql -h 127.0.0.1 -p 54322 -U u1_catalog_fixture -d postgres -X --set=ON_ERROR_STOP=1 --single-transaction --file=-
psql "$STILL_SECURITY_TEST_DATABASE_URL" -X --set=ON_ERROR_STOP=1 --single-transaction \
  --file=scripts/backend/sql/prepare-hardened-rls.sql \
  --file=scripts/backend/sql/assert-security.sql
supabase test db supabase/tests/rls_test.sql
psql "$STILL_SECURITY_TEST_DATABASE_URL" -X --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/assert-security.sql
# Handler and boundary suites are actual code; the external RevenueCat response is synthetic.
deno test --config supabase/functions/deno.json supabase/functions/_shared/auth.test.ts supabase/functions/_shared/jwt.test.ts supabase/functions/reconcile-entitlement/handler.test.ts supabase/functions/revenuecat-webhook/handler.test.ts
# Migration 0014 on its own, with no privileged candidate: upgrade path (0013 plus realistic
# synthetic rows, then the CLI applies 0014 as the ordinary postgres role) and clean path. Client
# probes log in as the real `authenticator` role and switch role as PostgREST does.
grants_test() {
  STILL_GRANTS_TEST_DATABASE_URL="$STILL_SECURITY_TEST_DATABASE_URL" STILL_GRANTS_TEST_MODE="$1" \
    deno test --config supabase/functions/deno.json "$db_test_env" --allow-read=supabase/migrations,supabase/tests --allow-net=127.0.0.1:54322 supabase/tests/server_rpc_grants_test.ts
}
# Apply pending migrations only up to and including version $1, still through the CLI as the
# ordinary postgres role, from a temporary copy of the project that holds no later migration.
migrate_up_to() {
  local upto
  upto=$(mktemp -d)
  mkdir -p "$upto/supabase/migrations"
  cp supabase/config.toml "$upto/supabase/"
  for migration in supabase/migrations/*.sql; do
    local name=${migration##*/}
    if (( 10#${name%%_*} <= 10#$1 )); then cp "$migration" "$upto/supabase/migrations/"; fi
  done
  supabase migration up --local --workdir "$upto" >/dev/null
  rm -rf "$upto"
}
# 0014 as the newest migration (the state production holds between the two deploys): upgrade
# from 0013 with realistic rows, then a clean database at exactly 0014. Its re-apply and
# self-check steps run here; at the 0015 head they are skipped.
supabase db reset --local --no-seed --version 0013 >/dev/null
psql "$STILL_SECURITY_TEST_DATABASE_URL" -X --set=ON_ERROR_STOP=1 --file=supabase/tests/server_rpc_grants_seed.sql
migrate_up_to 0014
grants_test upgrade
supabase db reset --local --no-seed --version 0014 >/dev/null
grants_test clean
# The existing pgTAP suite against migrations alone (no candidate). On 0013 it fails the
# set_entitlement, entitlement-write and anon free-sync checks; 0014 must make it pass.
supabase test db supabase/tests/rls_test.sql
# Separately, 0014's end state still holds at the head (stricter search_path form).
supabase db reset --local --no-seed >/dev/null
grants_test clean
# Migration 0015 on its own, as the newest migration (the state production holds between the 0015
# and 0016 deploys; 0015's check enumerates the private schema, which 0016 extends): upgrade from
# 0014 with realistic released-app rows (its verification first reports the missing objects, then
# the CLI applies 0015 as the ordinary postgres role), then a clean database at exactly 0015.
# Client probes use `authenticator`.
u3_migration_test() {
  STILL_U3_MIGRATION_TEST_DATABASE_URL="$STILL_SECURITY_TEST_DATABASE_URL" STILL_U3_MIGRATION_TEST_MODE="$1" \
    deno test --config supabase/functions/deno.json "$db_test_env" --allow-read=supabase/migrations,supabase/tests,scripts/backend/deploy/verify --allow-net=127.0.0.1:54322 supabase/tests/settings_sync_migration_test.ts
}
supabase db reset --local --no-seed --version 0014 >/dev/null
psql "$STILL_SECURITY_TEST_DATABASE_URL" -X --set=ON_ERROR_STOP=1 --file=supabase/tests/settings_sync_migration_seed.sql
u3_migration_test pre-upgrade
migrate_up_to 0015
u3_migration_test upgrade
supabase db reset --local --no-seed --version 0015 >/dev/null
u3_migration_test clean
# The pgTAP suite again at 0015, after the per-field path has been exercised.
supabase test db supabase/tests/rls_test.sql
# Migration 0016 on its own: upgrade from 0015 with realistic rows (its verification first reports
# the missing objects, then the CLI applies 0016 as the ordinary postgres role), then a clean head.
# The owner and public routes run through the real handlers as the two narrow roles.
u6_policy_test() {
  STILL_U6_POLICY_TEST_DATABASE_URL="$STILL_SECURITY_TEST_DATABASE_URL" STILL_U6_POLICY_TEST_MODE="$1" \
    deno test --config supabase/functions/deno.json "$db_test_env" --allow-read=supabase/migrations,supabase/tests,scripts/backend/deploy/verify --allow-net=127.0.0.1:54322 supabase/tests/product_policy_migration_test.ts
}
supabase db reset --local --no-seed --version 0015 >/dev/null
psql "$STILL_SECURITY_TEST_DATABASE_URL" -X --set=ON_ERROR_STOP=1 --file=supabase/tests/product_policy_migration_seed.sql
u6_policy_test pre-upgrade
supabase migration up --local >/dev/null
u6_policy_test upgrade
supabase db reset --local --no-seed >/dev/null
u6_policy_test clean
# The pgTAP suite again at the head, after the policy routes have been exercised.
supabase test db supabase/tests/rls_test.sql
node scripts/backend/plan.mjs verify "$1" synthetic-github-runner "$RUNNER_TEMP/u1-plan.json" "$2"
