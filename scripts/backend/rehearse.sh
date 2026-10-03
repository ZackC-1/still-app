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
export STILL_SECURITY_TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'
deno test --config supabase/functions/deno.json --allow-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT,STILL_SECURITY_TEST_DATABASE_URL,PGSSL,PGSSLNEGOTIATION,PGIDLE_TIMEOUT,PGCONNECT_TIMEOUT,PGMAX_LIFETIME,PGMAX_PIPELINE,PGBACKOFF,PGKEEP_ALIVE,PGDEBUG,PGFETCH_TYPES,PGPUBLICATIONS,PGTARGET_SESSION_ATTRS,PGTARGETSESSIONATTRS,PGAPPNAME --allow-read=scripts/backend/sql --allow-net=127.0.0.1:54322 supabase/tests/security_foundation_test.ts
supabase db reset --local --no-seed >/dev/null
# The reset removed the first test's candidates. Reinstall them atomically so pgTAP proves
# cross-account isolation against the hardened state, with extension-only test helper grants.
psql "$STILL_SECURITY_TEST_DATABASE_URL" -X --set=ON_ERROR_STOP=1 --single-transaction \
  --file=scripts/backend/sql/security-audit-candidate.sql \
  --file=scripts/backend/sql/hardening-candidate.sql \
  --file=scripts/backend/sql/prepare-hardened-rls.sql \
  --file=scripts/backend/sql/assert-security.sql
supabase test db supabase/tests/rls_test.sql
psql "$STILL_SECURITY_TEST_DATABASE_URL" -X --set=ON_ERROR_STOP=1 --file=scripts/backend/sql/assert-security.sql
# Handler and boundary suites are actual code; the external RevenueCat response is synthetic.
deno test --config supabase/functions/deno.json supabase/functions/_shared/auth.test.ts supabase/functions/_shared/jwt.test.ts supabase/functions/reconcile-entitlement/handler.test.ts supabase/functions/revenuecat-webhook/handler.test.ts
node scripts/backend/plan.mjs verify "$1" synthetic-github-runner "$RUNNER_TEMP/u1-plan.json" "$2"
