#!/usr/bin/env bash
set -euo pipefail
# Disposable proof of the read-only QA check route: migrations at head, the candidate role/views
# installed twice (idempotent, with its own end-state check), then every catalogue check run as
# the real narrow role against synthetic QA accounts and a synthetic customer
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
supabase db reset --local --no-seed >/dev/null
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
psql "$db_url" -X -q --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/qa-readonly-checks-candidate.sql
psql "$db_url" -X -q --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/qa-readonly-checks-candidate.sql
STILL_REQUIRE_CLOUD_TESTS=1 STILL_QA_CHECKS_TEST_DATABASE_URL="$db_url" \
  deno test --frozen --config supabase/functions/deno.json \
    --allow-env=STILL_REQUIRE_CLOUD_TESTS,STILL_QA_CHECKS_TEST_DATABASE_URL,PGHOST,PGPORT,PGUSERNAME,PGUSER,PGDATABASE,PGPASSWORD,PGSSL,PGSSLNEGOTIATION,PGIDLE_TIMEOUT,PGCONNECT_TIMEOUT,PGMAX_LIFETIME,PGMAX_PIPELINE,PGBACKOFF,PGKEEP_ALIVE,PGDEBUG,PGFETCH_TYPES,PGPUBLICATIONS,PGTARGET_SESSION_ATTRS,PGTARGETSESSIONATTRS,PGAPPNAME \
    --allow-net=127.0.0.1:54322 scripts/backend/qa-checks/run-db.test.ts
