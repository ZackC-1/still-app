#!/usr/bin/env bash
set -euo pipefail
# Full gateway/GoTrue/edge runtime ONLY on an ephemeral hosted Linux runner.
if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_ENVIRONMENT:-} != github-hosted || $(uname -s) != Linux ]]; then
  echo 'Cloud rehearsal requires an ephemeral GitHub-hosted Linux runner.' >&2; exit 1
fi
if [[ $# != 2 || ! $1 =~ ^[a-f0-9]{40}$ || ! $2 =~ ^[a-f0-9]{64}$ || $(git rev-parse HEAD) != "$1" ]]; then
  echo 'Exact reviewed revision and rehearsal digest required.' >&2; exit 1
fi
node scripts/backend/plan.mjs verify "$1" synthetic-github-runner "$RUNNER_TEMP/u1-plan.json" "$2"
export STILL_REQUIRE_CLOUD_TESTS=1
serve_pid=''
fixture_root=''
cleanup() {
  if [[ -n $serve_pid ]]; then kill "$serve_pid" >/dev/null 2>&1 || true; wait "$serve_pid" >/dev/null 2>&1 || true; fi
  supabase stop --project-id still-app --no-backup >/dev/null 2>&1 || return 1
  rm -f "$RUNNER_TEMP/access-default.env" "$RUNNER_TEMP/access-synthetic.env" "$RUNNER_TEMP/access-state.json" "$RUNNER_TEMP/access-serve.log"
  if [[ -n $fixture_root ]]; then rm -rf "$fixture_root"; fi
  if [[ -n $(docker ps -aq --filter label=com.supabase.cli.project=still-app) || -n $(docker volume ls -q --filter label=com.supabase.cli.project=still-app) ]]; then
    echo 'Disposable access runtime cleanup incomplete.' >&2; return 1
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
export SUPABASE_AUTH_JWT_ISSUER='http://kong:8000/auth/v1'
supabase start --exclude studio,imgproxy,mailpit,logflare,vector >/dev/null
access_version=${STILL_ACCESS_REHEARSAL_VERSION:-0020}
if [[ $access_version != 0020 && $access_version != 0021 ]]; then
  echo 'Unsupported access rehearsal schema version.' >&2; exit 1
fi
supabase db reset --local --no-seed --version "$access_version" >/dev/null
# Only the existing narrow writer is enabled with a disposable test credential.
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -X --set=ON_ERROR_STOP=1 <<'SQL'
alter role still_entitlement_writer login password 'access-synthetic-writer-only';
SQL
umask 077
printf '%s\n' 'ENTITLEMENT_WRITER_DB_URL=postgresql://still_entitlement_writer:access-synthetic-writer-only@db:5432/postgres' > "$RUNNER_TEMP/access-default.env"
export STILL_ACCESS_CLI_ANON_KEY
STILL_ACCESS_CLI_ANON_KEY=$(supabase status -o json | jq -er '.ANON_KEY')
# No --no-verify-jwt: config.toml's actual per-function gateway policy stays enabled.
start_serve() {
  local project="$1" env_file="$2"
  supabase functions serve --workdir "$project" --env-file "$env_file" > "$RUNNER_TEMP/access-serve.log" 2>&1 &
  serve_pid=$!
}
served_test() {
  if ! kill -0 "$serve_pid" 2>/dev/null || ! deno test --frozen --config supabase/functions/deno.json \
    --allow-env --allow-read="$RUNNER_TEMP/access-state.json" --allow-net=127.0.0.1:54321 \
    supabase/tests/access_served_test.ts; then
    # Logs may contain credentials or payloads. Only fixed diagnostic categories are printed.
    # Exact ephemeral container only; finite tail and bounded classifier buffer, never raw output.
    # The diagnostic timeout is failure-only and does not change any request/retry deadline.
    timeout 5s docker logs --tail 200 supabase_edge_runtime_still-app 2>&1 | \
      node scripts/backend/access-cli-diagnostics.mjs "$RUNNER_TEMP/access-serve.log" "$STILL_ACCESS_SERVED_PHASE" || true
    exit 1
  fi
}
read_mount() {
  local source="$1" mount
  mount=$(docker inspect supabase_edge_runtime_still-app | jq -er --arg source "$source/supabase/functions" '.[0].Mounts | map(select(.Source == $source and .RW == false)) | if length == 1 then .[0].Destination else error("Expected read-only function mount") end')
  for name in verify-apple-access link-apple-access reconcile-entitlement; do
    for artifact in index.ts deno.json; do
      docker exec supabase_edge_runtime_still-app cat "$mount/$name/$artifact" > "$RUNNER_TEMP/access-mounted"
      cmp "$source/supabase/functions/$name/$artifact" "$RUNNER_TEMP/access-mounted"
    done
  done
  docker exec supabase_edge_runtime_still-app cat "$mount/deno.lock" > "$RUNNER_TEMP/access-mounted"
  cmp "$source/supabase/functions/deno.lock" "$RUNNER_TEMP/access-mounted"
  rm -f "$RUNNER_TEMP/access-mounted"
}
export STILL_ACCESS_SERVED_PHASE=default
start_serve "$(pwd)" "$RUNNER_TEMP/access-default.env"
served_test
read_mount "$(pwd)"
kill "$serve_pid" >/dev/null 2>&1 || true; wait "$serve_pid" >/dev/null 2>&1 || true; serve_pid=''
# An isolated copy changes ONLY provider module aliases. Exact entrypoint, handler, auth,
# confirmation HTTP port, limiter, SQL store and Ed25519 issuer are exercised unchanged.
fixture_root=$(mktemp -d "$RUNNER_TEMP/access-fixture.XXXXXX")
node scripts/backend/prepare-access-fixture.mjs "$fixture_root" "$RUNNER_TEMP/access-synthetic.env" "$RUNNER_TEMP/access-state.json"
export STILL_ACCESS_SERVED_PHASE=synthetic
export STILL_ACCESS_SERVED_STATE_FILE="$RUNNER_TEMP/access-state.json"
start_serve "$fixture_root" "$RUNNER_TEMP/access-synthetic.env"
served_test
read_mount "$fixture_root"
node scripts/backend/plan.mjs verify "$1" synthetic-github-runner "$RUNNER_TEMP/u1-plan.json" "$2"
