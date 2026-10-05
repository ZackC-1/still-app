#!/usr/bin/env bash
# Plan-job rehearsal of ONE exact deploy on a throwaway database inside the runner.
# No secrets, no production access. Starts a database ONLY on an ephemeral GitHub-hosted runner.
set -euo pipefail

if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_ENVIRONMENT:-} != github-hosted || $(uname -s) != Linux ]]; then
  echo 'Replay requires an ephemeral GitHub-hosted Linux runner.' >&2
  exit 1
fi
if [[ $# != 2 || ! -f $1 || -e $2 ]]; then
  echo 'Usage: replay.sh <plan.json> <new empty deploy directory>' >&2
  exit 1
fi
plan=$1
dir=$2

cleanup() {
  supabase stop --workdir "$dir" --no-backup >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Database at the expected pre-change state: every migration at the commit except the listed ones.
node scripts/backend/deploy/deploy.mjs workdir --plan "$plan" --dir "$dir" --stage prior
supabase start --workdir "$dir" \
  --exclude gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor \
  >/dev/null

# The exact production code path (dry run, history checks, db push, read-only verification),
# pointed at the runner's own database as the ordinary non-superuser `postgres` role.
SUPABASE_DB_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
  node scripts/backend/deploy/deploy.mjs replay --plan "$plan" --dir "$dir"
