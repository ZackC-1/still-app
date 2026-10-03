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
trap 'exit 130' INT TERM
# Real managed Supabase on the hosted runner only. Auth/gateway/runtime remain present for CLI serve.
# Align this disposable Auth issuer with CLI serve's internal SUPABASE_URL.
# This supported CLI config override is scoped to this runner process; it is
# never injected into the function env file and does not change checked-in config.
export SUPABASE_AUTH_JWT_ISSUER='http://kong:8000/auth/v1'
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
deno test --frozen --config supabase/functions/deno.json --allow-env --allow-read=scripts/backend/sql --allow-net=127.0.0.1:54322 --filter 'U3 SQL lifecycle' supabase/tests/settings_sync_test.ts
umask 077
export STILL_SETTINGS_REHEARSAL_INSTANCE
STILL_SETTINGS_REHEARSAL_INSTANCE=$(node -e 'console.log(require("node:crypto").randomUUID())')
# The pinned CLI uses the db network alias: Deno rejects '_' in container names.
printf '%s\n' 'SETTINGS_WRITER_DB_URL=postgresql://still_settings_writer:u3-synthetic-settings-only@db:5432/postgres' "SETTINGS_REHEARSAL_INSTANCE=$STILL_SETTINGS_REHEARSAL_INSTANCE" > "$RUNNER_TEMP/u3-function.env"
export STILL_SETTINGS_CLI_JWT_SECRET
STILL_SETTINGS_CLI_JWT_SECRET=$(supabase status -o json | jq -er '.JWT_SECRET')
export STILL_SETTINGS_CLI_ANON_KEY
STILL_SETTINGS_CLI_ANON_KEY=$(supabase status -o json | jq -er '.ANON_KEY')
# Use actual CLI package/serve, including function-specific imports; gateway verification stays enabled.
supabase functions serve sync-settings --env-file "$RUNNER_TEMP/u3-function.env" --import-map supabase/functions/sync-settings/deno.json > "$RUNNER_TEMP/u3-serve.log" 2>&1 &
serve_pid=$!
export STILL_SETTINGS_SERVED_URL='http://127.0.0.1:54321/functions/v1/sync-settings'
# The test polls an authenticated canonical read carrying the exact process marker;
# an old gateway/runtime's arbitrary HTTP response cannot satisfy readiness.
if ! kill -0 "$serve_pid" 2>/dev/null || ! deno test --frozen --config supabase/functions/deno.json --allow-env --allow-net=127.0.0.1:54321,127.0.0.1:54322 --filter 'U3 actual Supabase CLI' supabase/tests/settings_sync_served_test.ts; then
  cli_running=false
  if kill -0 "$serve_pid" 2>/dev/null; then cli_running=true; fi
  # Never print raw CLI output: startup failures can contain credentials, headers,
  # source paths or payloads. Read at most the final 64 KiB and emit fixed enums.
  node --input-type=module - "$RUNNER_TEMP/u3-serve.log" "$cli_running" <<'SETTINGS_CLI_DIAGNOSTICS'
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
const result = { running: process.argv[3] === "true", log: "unavailable", truncated: false, categories: [] };
let fd;
try {
  fd = openSync(process.argv[2], "r");
  const size = fstatSync(fd).size;
  const bytes = Buffer.alloc(Math.min(size, 65536));
  const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
  const text = bytes.subarray(0, count).toString("utf8");
  result.log = "read";
  result.truncated = size > 65536;
  for (const [category, pattern] of [
    ["import-resolution", /module not found|failed to read file|failed to resolve|cannot resolve|import map/i],
    ["worker-boot", /worker boot error|failed to create worker|boot failed/i],
    ["reserved-env", /env name cannot start with supabase_/i],
    ["connection", /connection refused|could not connect|network unreachable/i],
    ["jwt-verification", /invalid jwt|jwt verification failed/i],
    // These fixed markers locate the failing boundary; they do not prove its cause.
    // PgRateLimiter deliberately removes the original driver error before logging.
    ["rate-limiter-unavailable", /\bRate limiter unavailable\b/],
    ["driver-connection", /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|CONNECTION_CLOSED|CONNECTION_ENDED|CONNECT_TIMEOUT)\b/],
    ["runtime-error-class", /\b(?:TypeError|NotSupported|NotSupportedError)\s*:/],
    ["database-authentication", /\b(?:code|SQLSTATE)\s*[:=]\s*["']?(?:28P01|28000)\b/i],
    ["database-privilege", /\b(?:code|SQLSTATE)\s*[:=]\s*["']?42501\b/i],
    ["database-resource", /\b(?:code|SQLSTATE)\s*[:=]\s*["']?(?:53300|57P03)\b/i],
    ["database-timeout", /\b(?:code|SQLSTATE)\s*[:=]\s*["']?(?:57014|55P03)\b/i],
    ["database-connection", /\b(?:code|SQLSTATE)\s*[:=]\s*["']?(?:08000|08001|08003|08004|08006|08007|08P01)\b/i],
  ]) {
    if (pattern.test(text)) result.categories.push(category);
  }
} catch { /* Missing/unreadable log is also a fixed enum. */ }
finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* No raw close error. */ } } }
console.log(JSON.stringify({ settingsCliFailure: result }));
SETTINGS_CLI_DIAGNOSTICS
  exit 1
fi
# Read back the actual pinned CLI's read-only function mount after authenticated
# readiness. The runtime must receive the same nearest config and frozen graph
# whose cold resolution passed before the source plan was sealed.
mounted_functions=$(docker inspect supabase_edge_runtime_still-app | jq -er --arg source "$(pwd)/supabase/functions" '.[0].Mounts | map(select(.Source == $source and .RW == false)) | if length == 1 then .[0].Destination else error("Expected one read-only function source mount") end')
for artifact in deno.json deno.lock; do
  docker exec supabase_edge_runtime_still-app cat "$mounted_functions/sync-settings/$artifact" > "$RUNNER_TEMP/u3-mounted-$artifact"
  cmp "supabase/functions/sync-settings/$artifact" "$RUNNER_TEMP/u3-mounted-$artifact"
done
node scripts/backend/plan.mjs verify "$1" synthetic-github-runner "$RUNNER_TEMP/u3-plan.json" "$2"
if [[ ${STILL_SETTINGS_REHEARSAL_WAIT_FOR_CANCEL:-} == true ]]; then
  # The separate hosted cancellation probe waits until this exact CLI process has
  # passed its authenticated contract, then sends TERM to exercise this EXIT cleanup.
  printf '%s\n' "$STILL_SETTINGS_REHEARSAL_INSTANCE" > "$RUNNER_TEMP/u3-cli-ready"
  while :; do sleep 1; done
fi
