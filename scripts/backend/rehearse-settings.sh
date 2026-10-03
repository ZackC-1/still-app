#!/usr/bin/env bash
set -euo pipefail
if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_ENVIRONMENT:-} != github-hosted || $(uname -s) != Linux ]]; then
  echo 'Settings rehearsal requires an ephemeral GitHub-hosted Linux runner.' >&2
  exit 1
fi
if [[ $# != 2 || ! $1 =~ ^[a-f0-9]{40}$ || ! $2 =~ ^[a-f0-9]{64}$ || $(git rev-parse HEAD) != "$1" ]]; then
  echo 'Supply exact checkout revision and immutable source digest.' >&2
  exit 1
fi
node scripts/backend/plan.mjs verify "$1" synthetic-github-runner "$RUNNER_TEMP/u3-plan.json" "$2"
serve_pid=''
cleanup() {
  if [[ -n $serve_pid ]]; then kill "$serve_pid" 2>/dev/null || true; wait "$serve_pid" 2>/dev/null || true; fi
  supabase stop --project-id still-app --no-backup
  if [[ -n $(docker ps -aq --filter label=com.supabase.cli.project=still-app) || -n $(docker volume ls -q --filter label=com.supabase.cli.project=still-app) ]]; then
    echo 'Targeted Supabase containers or volumes remain.' >&2
    return 1
  fi
}
trap cleanup EXIT
# Real managed Supabase on the hosted runner only. Auth/gateway/runtime remain present for CLI serve.
supabase start --exclude studio,imgproxy,mailpit,logflare,vector >/dev/null
supabase db reset --local --no-seed >/dev/null
docker exec -i supabase_db_still-app psql -U supabase_admin -d postgres -X --set=ON_ERROR_STOP=1 <<'SQL'
do $$ begin
  if not exists(select 1 from pg_catalog.pg_roles where rolname='u1_catalog_fixture') then
    create role u1_catalog_fixture login superuser password 'u1-synthetic-fixture-only';
  end if;
end $$;
SQL
export STILL_SETTINGS_TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'
psql "$STILL_SETTINGS_TEST_DATABASE_URL" -X --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/catalog-reconciliation.sql
PGPASSWORD='u1-synthetic-fixture-only' psql -h 127.0.0.1 -p 54322 -U u1_catalog_fixture -d postgres -X --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/synthetic-catalog-fixture.sql
psql "$STILL_SETTINGS_TEST_DATABASE_URL" -X --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/security-audit-candidate.sql
# The test proves ordinary postgres denial/rollback before explicit synthetic-admin hardening+candidate.
deno test --no-lock --config supabase/functions/deno.json --allow-env --allow-read=scripts/backend/sql --allow-net=127.0.0.1:54322 --filter 'U3 SQL lifecycle' supabase/tests/settings_sync_test.ts
printf '%s\n' 'SETTINGS_WRITER_DB_URL=postgresql://still_settings_writer:u3-synthetic-settings-only@supabase_db_still-app:5432/postgres' > "$RUNNER_TEMP/u3-function.env"
export STILL_SETTINGS_CLI_JWT_SECRET
STILL_SETTINGS_CLI_JWT_SECRET=$(supabase status -o json | jq -er '.JWT_SECRET')
# Use actual CLI package/serve, including function-specific imports; gateway verification stays enabled.
supabase functions serve sync-settings --env-file "$RUNNER_TEMP/u3-function.env" --import-map supabase/functions/sync-settings/deno.json > "$RUNNER_TEMP/u3-serve.log" 2>&1 &
serve_pid=$!
export STILL_SETTINGS_SERVED_URL='http://127.0.0.1:54321/functions/v1/sync-settings'
ready=false
for attempt in $(seq 1 60); do
  if curl -s -o /dev/null --max-time 1 "$STILL_SETTINGS_SERVED_URL"; then ready=true; break; fi
  if ! kill -0 "$serve_pid" 2>/dev/null; then echo 'CLI serve exited before readiness.' >&2; exit 1; fi
  sleep 1
done
if [[ $ready != true ]]; then echo 'CLI serve readiness timed out.' >&2; exit 1; fi
deno test --no-lock --config supabase/functions/deno.json --allow-env --allow-net=127.0.0.1:54321 --filter 'U3 actual Supabase CLI' supabase/tests/settings_sync_test.ts
node scripts/backend/plan.mjs verify "$1" synthetic-github-runner "$RUNNER_TEMP/u3-plan.json" "$2"
