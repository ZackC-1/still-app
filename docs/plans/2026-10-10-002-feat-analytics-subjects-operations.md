# Protected operations to switch on signed-in analytics

Status: source complete on `feat/v31-analytics-subjects-operation-20261010`; not merged, nothing
run against the hosted project.

## Intent

PR #402 lists five owner steps to switch on per-device analytics identities. Each must be an
owner-approved protected deploy, never the Supabase CLI or a manual change. This adds four closed
operations to the `Supabase production deploy` workflow, in `scripts/backend/deploy/analytics-subjects.mjs`:

1. `analytics-subjects-secrets` (apply, rotate): eraser password, worker token and event-id secret
   generated in runner memory; function secrets written through the Management API; eraser LOGIN
   by SCRAM verifier; the worker token copied to Supabase Vault for the schedule.
2. `analytics-subjects-functions` (apply): `analytics-erasure`, `analytics-identify`, `delete-user`
   as sealed bundles with byte readback (the QA function uploader, generalized over a route set).
3. `analytics-erasure-schedule` (enable, disable): pg_cron + pg_net job every 15 minutes, token
   read from Vault at run time; pinned command checked by hash.
4. `analytics-subjects-switch` (enable, disable): `ANALYTICS_SUBJECTS_ENABLED` then a redeploy of
   `analytics-identify`.

Hard gates are enforced in the operations: 0017/0018 in history and 0018's check clean; a green
GoTrue deletion rehearsal on the exact commit; runtime secrets, eraser sign-in and Vault/secret
digest agreement; routes at the planned source; for the switch, a verified schedule that has run
and a worker answer that skipped nothing. The disable directions have no gate.

Choices: in-runner password generation (the `qa-sandbox-secrets` pattern), not an owner-pasted
verifier, so no person ever holds the eraser password and nothing is done by hand. The existing
Secrets-only token is reused, so the owner creates no new environment secret. `delete-user` is in
the route list because the hard gate needs its current code and no other protected path deploys it.

## Verification

- `node --test` over the deploy suites (analytics, workflow, deploy, operations, QA functions and
  secrets, bundles): all pass.
- The full lifecycle rehearsal (`runAnalyticsReplay`) passed against a local `supabase/postgres`
  17.11 container with every repository migration applied (not the Supabase CLI), including a real
  build of the three bundles. The pinned SQL was exercised there: Vault create and update through
  `\bind`, the eraser sign-in, schedule enable/disable and the worker-evidence counts.
- CI runs the same rehearsal in `supabase-operation-rehearsal.yml` (two analytics rows).

Runbook: [docs/release/analytics-subjects-switch-on.md](../release/analytics-subjects-switch-on.md).
