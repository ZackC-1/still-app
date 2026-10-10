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

## Security review fixes (F1–F7)

- F1: a worker answer counts only with `failed = 0` and `lost = 0`; switch-on also runs a provider
  proof inside `analytics-erasure` (`{"action":"provider-check"}`, worker-token gated, asked through
  pg_net with the Vault token): project read with the personal key whose public token must equal
  `POSTHOG_PROJECT_KEY`, and a bulk_delete of one random id (202, persons_found 0, no errors).
- F2 (server half): the V3 identify body must carry `projectKeySha256`; anything but the live
  project's digest is answered `{"state":"test_channel"}` with nothing written. The client half
  conflicts with PR #403 and is routed separately; step 4 waits for it.
- F3: the Secrets-only token must be refused by GET /functions (steps 1 and 4).
- F4: the released identify body's limiter prefers the writer login.
- F5: runbook checks after step 2. F6: `postgres` cannot revoke pg_net's grants (owned by
  `supabase_admin`); documented, plus a role-facts comparison in step 3. F7: rotate skips the
  history, migration and rehearsal gates.

## Verification

- `node --test` over the deploy suites (analytics, workflow, deploy, operations, QA functions and
  secrets, bundles): all pass.
- The full lifecycle rehearsal (`runAnalyticsReplay`) passed against a local `supabase/postgres`
  17.11 container with every repository migration applied (not the Supabase CLI), including a real
  build of the three bundles. The pinned SQL was exercised there: Vault create and update through
  `\bind`, the eraser sign-in, schedule enable/disable and the worker-evidence counts.
- CI runs the same rehearsal in `supabase-operation-rehearsal.yml` (two analytics rows).

Runbook: [docs/release/analytics-subjects-switch-on.md](../release/analytics-subjects-switch-on.md).
