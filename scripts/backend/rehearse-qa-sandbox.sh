#!/usr/bin/env bash
set -euo pipefail
# Database execution belongs only to a disposable hosted Linux runner.
if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_ENVIRONMENT:-} != github-hosted || $(uname -s) != Linux ]]; then
  echo 'Cloud rehearsal requires an ephemeral GitHub-hosted Linux runner.' >&2; exit 1
fi
if [[ $# != 2 || ! $1 =~ ^[a-f0-9]{40}$ || ! $2 =~ ^[a-f0-9]{64}$ || $(git rev-parse HEAD) != "$1" ]]; then
  echo 'Exact reviewed revision and rehearsal digest required.' >&2; exit 1
fi
node scripts/backend/plan.mjs verify "$1" synthetic-github-runner "$RUNNER_TEMP/u1-plan.json" "$2"
readonly qa_database_url='postgresql://postgres:postgres@127.0.0.1:54322/postgres'
upgrade_root=''
cleanup() {
  supabase stop --project-id still-app --no-backup >/dev/null 2>&1 || return 1
  if [[ -n $upgrade_root ]]; then rm -rf "$upgrade_root"; fi
  if [[ -n $(docker ps -aq --filter label=com.supabase.cli.project=still-app) || -n $(docker volume ls -q --filter label=com.supabase.cli.project=still-app) ]]; then
    echo 'Disposable QA database cleanup incomplete.' >&2; return 1
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
export STILL_REQUIRE_CLOUD_TESTS=1
export STILL_ACCESS_TEST_DATABASE_URL="$qa_database_url"
supabase start --exclude gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor >/dev/null
qa_test() {
  deno test --frozen --config supabase/functions/deno.json \
    --allow-env=STILL_REQUIRE_CLOUD_TESTS,STILL_ACCESS_TEST_DATABASE_URL,STILL_QA_SANDBOX_UPGRADE_REQUIRED,GITHUB_ACTIONS,RUNNER_ENVIRONMENT,PGSSL,PGSSLNEGOTIATION,PGIDLE_TIMEOUT,PGCONNECT_TIMEOUT,PGMAX_LIFETIME,PGMAX_PIPELINE,PGBACKOFF,PGKEEP_ALIVE,PGDEBUG,PGFETCH_TYPES,PGPUBLICATIONS,PGTARGET_SESSION_ATTRS,PGTARGETSESSIONATTRS,PGAPPNAME \
    --allow-read=supabase/tests/qa_sandbox_access_seed.sql,scripts/backend/deploy/verify/0021_qa_sandbox_access.sql,scripts/backend/deploy/rollback/0021_qa_sandbox_access.sql \
    --allow-net=127.0.0.1:54322 supabase/tests/qa_sandbox_access_test.ts
}
head_creator_audit() {
  # Reuse the reviewed U1 fixture only on this disposable database. QA's own gate has
  # already checked its default ACL before generic creator hardening can repair anything.
  docker exec -i supabase_db_still-app psql -U supabase_admin -d postgres -X --set=ON_ERROR_STOP=1 <<'SQL'
do $$ begin
  if not exists(select 1 from pg_roles where rolname='u1_catalog_fixture') then
    create role u1_catalog_fixture login superuser password 'u1-synthetic-fixture-only';
  end if;
end $$;
SQL
  psql "$qa_database_url" -X --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/catalog-reconciliation.sql
  PGPASSWORD='u1-synthetic-fixture-only' psql -h 127.0.0.1 -p 54322 -U u1_catalog_fixture -d postgres -X --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/synthetic-catalog-fixture.sql
  psql "$qa_database_url" -X --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/security-audit-candidate.sql
  cat scripts/backend/sql/hardening-candidate.sql scripts/backend/sql/assert-security.sql | \
    PGPASSWORD='u1-synthetic-fixture-only' psql -h 127.0.0.1 -p 54322 -U u1_catalog_fixture -d postgres -X --set=ON_ERROR_STOP=1 --single-transaction --file=-
  psql "$qa_database_url" -X --set=ON_ERROR_STOP=1 --single-transaction \
    --file=scripts/backend/sql/prepare-hardened-rls.sql \
    --file=scripts/backend/sql/assert-security.sql
}
# Upgrade starts with real old RPCs, nonempty historical rows and an absent QA wrapper.
supabase db reset --local --no-seed --version 0020 >/dev/null
psql "$qa_database_url" -X --set=ON_ERROR_STOP=1 --file=supabase/tests/qa_sandbox_access_seed.sql
# The migration CLI applies only through this reviewed source version, even if later files exist.
upgrade_root=$(mktemp -d "$RUNNER_TEMP/qa-sandbox-upgrade.XXXXXX")
mkdir -p "$upgrade_root/supabase/migrations"
cp supabase/config.toml "$upgrade_root/supabase/"
for migration in supabase/migrations/*.sql; do
  name=${migration##*/}
  if (( 10#${name%%_*} <= 10#0021 )); then cp "$migration" "$upgrade_root/supabase/migrations/"; fi
done
# Execute the actual private deployment invariant against the seeded pre-upgrade rows.
# Never send its full-row fingerprints to CI output or retained artifacts.
umask 077
psql "$qa_database_url" -X -qAt --set=ON_ERROR_STOP=1 \
  --command='set session characteristics as transaction read only' \
  --file=scripts/backend/deploy/verify/0021_qa_sandbox_access.invariant.sql > "$upgrade_root/invariant-before.json"
# The deploy runs the end-state check before applying too; before 0021 it must report the absent
# QA objects as issues, never fail on a role or routine that does not exist yet.
pre_0021=$(psql "$qa_database_url" -X -qAt --set=ON_ERROR_STOP=1 \
  --command='set session characteristics as transaction read only' \
  --file=scripts/backend/deploy/verify/0021_qa_sandbox_access.sql | tail -n 1)
if [[ $pre_0021 != *'"missing_QA_role"'* ]]; then
  echo 'The 0021 end-state check did not report the absent QA roles before the upgrade.' >&2; exit 1
fi
echo '0021 end-state check before upgrade reports absent QA objects: PASS.'
supabase migration up --local --workdir "$upgrade_root" >/dev/null
psql "$qa_database_url" -X -qAt --set=ON_ERROR_STOP=1 \
  --command='set session characteristics as transaction read only' \
  --file=scripts/backend/deploy/verify/0021_qa_sandbox_access.invariant.sql > "$upgrade_root/invariant-after.json"
if [[ ! -s $upgrade_root/invariant-before.json ]] || ! cmp -s "$upgrade_root/invariant-before.json" "$upgrade_root/invariant-after.json"; then
  echo 'QA migration changed an existing private row invariant.' >&2; exit 1
fi
rm "$upgrade_root/invariant-before.json" "$upgrade_root/invariant-after.json"
echo 'QA migration private full-row preservation invariant: PASS.'
supabase test db supabase/tests/rls_test.sql
STILL_QA_SANDBOX_UPGRADE_REQUIRED=1 qa_test
head_creator_audit
# Clean-install evidence is distinct; it cannot satisfy the required pre-upgrade absence probe.
supabase db reset --local --no-seed --version 0021 >/dev/null
psql "$qa_database_url" -X -qAt --set=ON_ERROR_STOP=1 \
  --command='set session characteristics as transaction read only' \
  --file=scripts/backend/deploy/verify/0021_qa_sandbox_access.invariant.sql >/dev/null
supabase test db supabase/tests/rls_test.sql
STILL_QA_SANDBOX_UPGRADE_REQUIRED=0 qa_test
head_creator_audit
node scripts/backend/plan.mjs verify "$1" synthetic-github-runner "$RUNNER_TEMP/u1-plan.json" "$2"
