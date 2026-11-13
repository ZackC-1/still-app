#!/usr/bin/env bash
set -euo pipefail
# Disposable proof of the read-only QA check route. Migrations 0025 and 0030 are rehearsed as hosted production
# meets it: the database at 0024 with the candidate role/views already installed (the checker role
# exists), its gate before and after, unchanged policy rows, wider-grant controls and a re-apply.
# Then the candidate is installed twice more (idempotent, with its own end-state check) and every
# catalogue check runs as the real narrow role against synthetic QA accounts and a synthetic customer
# (scripts/backend/qa-checks/run-db.test.ts). Database execution belongs only to a disposable
# GitHub-hosted Linux runner; this never touches a hosted project.
if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_ENVIRONMENT:-} != github-hosted || $(uname -s) != Linux ]]; then
  echo 'Cloud rehearsal requires an ephemeral GitHub-hosted Linux runner.' >&2; exit 1
fi
readonly db_url='postgresql://postgres:postgres@127.0.0.1:54322/postgres'
cleanup() {
  supabase stop --project-id still-app --no-backup >/dev/null 2>&1 || return 1
}
trap cleanup EXIT
trap 'exit 130' INT TERM
supabase start --exclude gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor >/dev/null
supabase db reset --local --no-seed --version 0024 >/dev/null
# Hosted Auth has auth.sessions (GoTrue's table). If this stack lacks it, add a minimal synthetic
# stand-in owned like the real one, so the sessions view can be created and exercised.
if [[ $(psql "$db_url" -XAtc "select pg_catalog.to_regclass('auth.sessions') is not null") != t ]]; then
  docker exec -i supabase_db_still-app psql -U supabase_admin -d postgres -X --set=ON_ERROR_STOP=1 <<'SQL'
create table auth.sessions (id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade, created_at timestamptz default now());
alter table auth.sessions owner to supabase_auth_admin;
grant select on auth.sessions to postgres;
SQL
fi
readonly gate_0025=scripts/backend/deploy/verify/0025_production_sales_summary_view.sql
readonly gate_0030=scripts/backend/deploy/verify/0030_production_purchase_operations_view.sql
gate_issues() { psql "$db_url" -X -At --set=ON_ERROR_STOP=1 --file="$1" | tail -n 1; }
prod02_rows() {
  psql "$db_url" -X -At --set=ON_ERROR_STOP=1 --file=scripts/backend/deploy/verify/0030_production_purchase_operations_view.invariant.sql
}
prod01_migration_test() {
  STILL_PROD01_TEST_DATABASE_URL="$db_url" STILL_PROD01_TEST_MODE="$1" \
    deno test --frozen --config supabase/functions/deno.json --allow-env=STILL_PROD01_TEST_DATABASE_URL,STILL_PROD01_TEST_MODE,STILL_REQUIRE_CLOUD_TESTS,PGHOST,PGPORT,PGUSERNAME,PGUSER,PGDATABASE,PGPASSWORD,PGSSL,PGSSLNEGOTIATION,PGIDLE_TIMEOUT,PGCONNECT_TIMEOUT,PGMAX_LIFETIME,PGMAX_PIPELINE,PGBACKOFF,PGKEEP_ALIVE,PGDEBUG,PGFETCH_TYPES,PGPUBLICATIONS,PGTARGET_SESSION_ATTRS,PGTARGETSESSIONATTRS,PGAPPNAME \
      --allow-read=scripts/backend/deploy/verify,supabase/migrations --allow-net=127.0.0.1:54322 \
      supabase/tests/production_sales_summary_migration_test.ts
}
prod01_rows() {
  psql "$db_url" -X -At --set=ON_ERROR_STOP=1 --file=scripts/backend/deploy/verify/0025_production_sales_summary_view.invariant.sql
}
# Production order: the candidate (checker role present) first, then 0025 through the CLI.
psql "$db_url" -X -q --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/qa-readonly-checks-candidate.sql
prod01_migration_test pre-upgrade
before_0030=$(gate_issues "$gate_0030")
if [[ $before_0030 != '["migration_version", "view_missing"]' ]]; then echo "0030 gate is vacuous before the apply: $before_0030" >&2; exit 1; fi
rows_before=$(prod01_rows)
supabase migration up --local >/dev/null
rows_after=$(prod01_rows)
if [[ "$rows_before" != "$rows_after" ]]; then echo '0025 changed product policy rows.' >&2; exit 1; fi
unset rows_before rows_after
prod01_migration_test upgrade
psql "$db_url" -X -q --set=ON_ERROR_STOP=1 --single-transaction --file=supabase/migrations/0025_production_sales_summary_view.sql >/dev/null
reapplied=$(psql "$db_url" -X -At --set=ON_ERROR_STOP=1 --file="$gate_0025" | tail -n 1)
if [[ $reapplied != '[]' ]]; then echo "0025 end-state check failed after a second apply: $reapplied" >&2; exit 1; fi
echo '0025 with the checker present: gate before/after, unchanged rows, wider-grant controls, idempotent re-apply: PASS.'
# 0030 (PROD-02 view) as hosted production meets it: applied by `migration up` above, checker present.
after_0030=$(gate_issues "$gate_0030")
if [[ $after_0030 != '[]' ]]; then echo "0030 end-state check failed after the apply: $after_0030" >&2; exit 1; fi
rows_before=$(prod02_rows)
psql "$db_url" -X -q --set=ON_ERROR_STOP=1 --single-transaction --file=supabase/migrations/0030_production_purchase_operations_view.sql >/dev/null
if [[ $(prod02_rows) != "$rows_before" ]]; then echo '0030 changed production purchase operation rows.' >&2; exit 1; fi
unset rows_before
reapplied=$(gate_issues "$gate_0030")
if [[ $reapplied != '[]' ]]; then echo "0030 end-state check failed after a second apply: $reapplied" >&2; exit 1; fi
echo '0030 with the checker present: gate before/after, unchanged rows, idempotent re-apply: PASS.'
psql "$db_url" -X -q --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/qa-readonly-checks-candidate.sql
psql "$db_url" -X -q --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/qa-readonly-checks-candidate.sql
after_candidate=$(psql "$db_url" -X -At --set=ON_ERROR_STOP=1 --file="$gate_0025" | tail -n 1)
if [[ $after_candidate != '[]' ]]; then echo "0025 end-state check failed after re-installing the candidate: $after_candidate" >&2; exit 1; fi
after_candidate=$(gate_issues "$gate_0030")
if [[ $after_candidate != '[]' ]]; then echo "0030 end-state check failed after re-installing the candidate: $after_candidate" >&2; exit 1; fi
STILL_REQUIRE_CLOUD_TESTS=1 STILL_QA_CHECKS_TEST_DATABASE_URL="$db_url" \
  deno test --frozen --config supabase/functions/deno.json \
    --allow-env=STILL_REQUIRE_CLOUD_TESTS,STILL_QA_CHECKS_TEST_DATABASE_URL,PGHOST,PGPORT,PGUSERNAME,PGUSER,PGDATABASE,PGPASSWORD,PGSSL,PGSSLNEGOTIATION,PGIDLE_TIMEOUT,PGCONNECT_TIMEOUT,PGMAX_LIFETIME,PGMAX_PIPELINE,PGBACKOFF,PGKEEP_ALIVE,PGDEBUG,PGFETCH_TYPES,PGPUBLICATIONS,PGTARGET_SESSION_ATTRS,PGTARGETSESSIONATTRS,PGAPPNAME \
    --allow-net=127.0.0.1:54322 scripts/backend/qa-checks/run-db.test.ts
