# Signed-in analytics: switching it on with protected operations

This switches on per-device analytics identities for signed-in people (owner decision 50; ADR
0004's V3 section; [PostHog runbook](posthog-analytics.md), "Per-device identities and device
deletion"). Every change goes through the protected **Supabase production deploy** workflow and
waits for the owner's approval. Nothing here is done with the Supabase CLI, in the Supabase
dashboard or in the SQL editor.

The code is `scripts/backend/deploy/analytics-subjects.mjs`, with its pinned SQL in
`scripts/backend/deploy/operations/analytics-*.sql`.

## Hosted state before these steps (from repository evidence, 10 October 2026)

| Piece | State | Evidence |
|---|---|---|
| Migration 0017 (analytics erasure storage, the narrow `still_analytics_eraser` role, the account-deletion snapshot trigger) | Applied and verified | Production deploy run 37974630638 (9 Oct), which ran 0017's read-only check after applying |
| Migration 0018 (account-wide erasure; deletion records identities first) | Applied and verified, together with 0019 | Production deploy run 37976701255 (9 Oct) |
| Hosted migration history | Ends at 0021 | Runs 37977720523 (0020) and 37978362666 (0021); QA programme DB-01 |
| `delete-user` | Version 18, deployed 23 Sept with the CLI, from the 2.1 code. **Not** the current code that records an account's device identities before deleting it | PostHog runbook, "Server"; no later deploy record. No protected path could deploy it until this change |
| `analytics-identify` | Version 1, deployed 23 Sept (2.1 code, before per-device identities) | Same |
| `analytics-erasure` | Not deployed | Absent from the live function list recorded on 9 Oct in `qa-secrets.mjs` |
| `POSTHOG_PROJECT_KEY`, `POSTHOG_HOST`, `POSTHOG_API_HOST`, `POSTHOG_PROJECT_ID`, `POSTHOG_PERSONAL_API_KEY` | Set 23 Sept for 2.1 | PostHog runbook, "Server". Deletion needs only the personal key with the **person: write** scope, limited to the one project, plus the project id. Both `delete-user` and `analytics-erasure` use PostHog's `persons/bulk_delete` endpoint and nothing else |
| `ANALYTICS_ERASER_DB_URL`, `ANALYTICS_EVENT_ID_SECRET`, `ANALYTICS_ERASURE_WORKER_TOKEN`, `ANALYTICS_SUBJECTS_ENABLED` | No record that any was ever set | Step 1 checks this for itself and refuses a half-set state |
| `still_analytics_eraser` sign-in | Off (0017 creates it with NOLOGIN); no record of a change | Step 1 reads it |
| Erasure worker schedule | None | 0017 left it open on purpose (owner question 7) |

**Sandbox first: there is no separate Supabase sandbox project.** The QA sandbox functions run on
the same hosted project, and `analytics-identify`, `analytics-erasure` and `delete-user` are
production routes that every app calls. So the "sandbox first" step is: (1) the plan job of every
run below rehearses the whole lifecycle on a throwaway copy of the database in GitHub (secrets,
functions, schedule, switch on, switch off, schedule off, rotate) before asking for approval; then
(2) after the switch is on, check it with a V3 QA package and a test account; and (3) if anything
looks wrong, switch it off at once (one approval, no other gate).

**Test builds never get an identity.** Test builds send their events to the PostHog test project,
while the server attaches emails and `account_created` in the live project. So `analytics-identify`
gives a device an identity only when the device proves it sends to the live project: the request
must carry `projectKeySha256`, the SHA-256 of the client's public PostHog project key, and it must
equal the digest of the server's `POSTHOG_PROJECT_KEY`. Any other request (a test build, or a build
without the field) is answered `{"state": "test_channel"}` with nothing written. **The client half
(apps sending `projectKeySha256`) is not in this change;** until it ships in the V3 builds, every V3
device keeps waiting even with the switch on, so step 4 waits for it.

## The owner's steps (four approvals)

Before starting, Claude:

1. Merges this change to `main` and notes the merge commit. All four runs use that one commit.
2. Starts the **Supabase settings rehearsal** workflow on `main` at that commit
   (`gh workflow run supabase-settings-rehearsal.yml --ref main`) and waits for it to pass. It
   deletes accounts through GoTrue and the real `delete-user` handler. Steps 1, 2, 3 and 4 refuse
   unless this rehearsal succeeded on exactly the planned commit. No approval is needed for it.
3. Confirms with the owner that the `SUPABASE_QA_SECRETS_ACCESS_TOKEN` environment secret still
   exists and is a Supabase token limited to project secrets. It is the only token that can write
   function secrets (steps 1 and 4 use it). Steps 1 and 4 also check it for themselves: if it can
   read the project's functions, they refuse (`secrets_token_too_broad`). A dedicated, narrower
   switch token would be better still; until then, do not revoke this one while analytics is on,
   because switch-off needs it.
4. Before step 4 only: in PostHog, give the personal API key that `POSTHOG_PERSONAL_API_KEY` holds
   the **project: read** scope as well as **person: write**, still limited to the one project
   (owner, in PostHog). Step 4's provider proof reads the project with it to check that deletions
   target the same project that receives the events. If PostHog makes a new key instead of editing
   the old one, the secret has to be replaced through a reviewed change first.

Then, for each step, Claude starts the run with the command shown and sends the owner its link. The
owner opens it, reads the plan in the summary, clicks **Review deployments**, ticks
**supabase-production** and clicks **Approve and deploy**. Claude checks the closing record before
starting the next step.

| Step | What it does | Claude starts it with |
|---|---|---|
| 1 | Generates, in the runner's memory only, the eraser password, the worker token and the event-id secret. Writes `ANALYTICS_ERASER_DB_URL`, `ANALYTICS_ERASURE_WORKER_TOKEN` and `ANALYTICS_EVENT_ID_SECRET`, gives the eraser role sign-in, and copies the worker token into Supabase Vault for the schedule. Nobody ever sees a value. | `gh workflow run supabase-production-deploy.yml --ref main -f commit=<sha> -f operation=analytics-subjects-secrets -f policy_mode=none -f mode=apply` |
| 2 | Deploys exactly `analytics-erasure`, then `analytics-identify`, then `delete-user`, built from that commit, and reads each one back byte for byte. Stops before `delete-user` if an earlier route does not read back. | `... -f operation=analytics-subjects-functions -f policy_mode=none -f mode=apply` |
| 3 | Schedules the deletion worker every 15 minutes (pg_cron with pg_net). The job reads the token from Vault when it runs. Run it soon after step 2. | `... -f operation=analytics-erasure-schedule -f policy_mode=enable -f mode=apply` |
| 4 | **Only after the client half of the test-channel check has shipped, and 15 to 30 minutes after step 3**, so the schedule has run at least once. Proves PostHog deletion, then sets `ANALYTICS_SUBJECTS_ENABLED=true` and redeploys `analytics-identify`. | `... -f operation=analytics-subjects-switch -f policy_mode=enable -f mode=apply` |

Right after step 2 (Claude, then the owner):

- Prepare a reviewed revert or fix-forward commit for the three routes, so a problem can be fixed
  through the same protected path.
- Delete one disposable team account through the production `delete-user` (from a production
  build, signed in as that account) and confirm the answer is `200 {"deleted": true}`.
- Watch the `analytics-identify` logs for 5xx answers to released 2.1 apps. Their rate limiter now
  prefers the long-proven writer login and only falls back to the eraser login.

What each step refuses, before writing anything:

- **Every step (except the two "off" directions and step 1's `rotate`):** migration history must
  hold 0017 and 0018; 0018's read-only check (which also re-checks 0017's account-deletion snapshot
  trigger and the eraser role) must be clean, apart from the one code a later reviewed migration
  explains (0020 replaced the shared rate limiter); and the GoTrue rehearsal must have passed on the
  commit. `rotate` is the recovery path, so it skips these and keeps only the eraser-role check, the
  token check and its own write checks; it is always safe to run again.
- **Steps 1 and 4 (on):** the Secrets-only token must be refused by the project's functions
  endpoint.
- **Step 1:** never replaces a value. A half-set state (a URL without sign-in, sign-in without a
  URL, a Vault token without the secret) refuses and names `rotate`.
- **Step 2:** the three analytics secrets and the five PostHog secrets must exist, the eraser must
  be able to sign in, and the Vault token must match the function secret (compared by digest only).
- **Step 3:** as step 2, and `analytics-erasure` must be deployed at exactly the planned source.
- **Step 4:** as step 2; all three routes at exactly the planned source; the schedule present with
  the exact planned command; pg_cron ran it in the last 35 minutes; a worker run in that window
  answered with a report that skipped nothing and has `failed: 0` and `lost: 0`; and, last, the
  **provider proof**: `analytics-erasure`, asked through pg_net with the Vault token, reads the
  PostHog project with the personal key (its public token must equal `POSTHOG_PROJECT_KEY`) and
  bulk-deletes one random, never-used id (accepted, nobody found, no errors). Only pass/fail codes
  come back.

Then check with a **production-channel** build (a test build is answered `test_channel` by design):
sign in with a disposable team account, confirm the app gets its analytics identity, and that the
live PostHog person for that device shows that account's email. Then delete the account and confirm
the device's person is removed after the next worker run (PostHog removes the events later, in a
batch). To exercise identities with a test build instead, point the server at the PostHog test
project; never send test accounts into the live project.

## Undo

| To | Run (one approval, no other gate) |
|---|---|
| Switch signed-in analytics off | `-f operation=analytics-subjects-switch -f policy_mode=disable -f mode=apply`: sets `ANALYTICS_SUBJECTS_ENABLED=false` and redeploys `analytics-identify` |
| Stop the deletion worker | `-f operation=analytics-erasure-schedule -f policy_mode=disable -f mode=apply`: removes only the job; queued deletions wait until it is scheduled again |
| Replace the eraser password and worker token (leak, or a step 1 that stopped after starting to write) | `-f operation=analytics-subjects-secrets -f policy_mode=none -f mode=rotate`: changes the password first, then rewrites the URL and token secrets and the Vault copy. The event-id secret is kept |

Switch off first if both are needed. The functions are not rolled back: while the switch is off,
`analytics-identify` issues no new device identity, and `delete-user` keeps recording any identity
issued earlier, so it is still deleted (once the worker runs).

## Reading a refusal

Closing records carry fixed codes only. The common ones:

| Code | Meaning and fix |
|---|---|
| `gotrue_rehearsal_not_green` | Run the Supabase settings rehearsal on the planned commit, wait for it to pass, then start the step again |
| `history_missing:0017` / `history_missing:0018`, `migration_gate:<code>` | The database is not in the state 0017/0018 promise. Stop and investigate; never "fix" it by hand |
| `missing_secret:<NAME>` | Run step 1 (or, for a `POSTHOG_*` name, restore the PostHog secret through a reviewed change) |
| `eraser_cannot_sign_in`, `worker_token_mismatch` | Step 1 has not run, or stopped part way: run step 1 in `rotate` mode |
| `function_not_at_source:<route>` | That route differs from the planned commit: run step 2 from the same commit |
| `schedule_missing`, `schedule_differs` | Run step 3 from the same commit |
| `schedule_not_running`, `worker_not_succeeding` | Wait for the next quarter hour and retry; if it persists, check the worker token and the `analytics-erasure` logs |
| `worker_provider_unconfigured` | The worker ran but PostHog deletion is not configured: check the PostHog personal key and project id |
| `worker_failing` | Worker runs reported failed or lost jobs: check PostHog, the personal key and the `analytics-erasure` logs |
| `provider:project_key_mismatch` | The personal key and project id point at a different PostHog project from the one receiving events: fix the secrets through a reviewed change |
| `provider:project_read_forbidden`, `provider:delete_forbidden` | The personal key lacks project: read or person: write on that project |
| `provider_check_unanswered`, `provider_check_http_<status>` | The function did not answer the proof: check that `analytics-erasure` is deployed and the worker token matches |
| `secrets_token_too_broad` | The Secrets-only token can also reach functions: replace it with a token limited to project secrets |
| `analytics-eraser-mismatch`, `analytics-worker-token-mismatch` | Step 1 found a half-set state: run step 1 in `rotate` mode |
| `outcome-unknown` status | A write may or may not have happened. Do not retry blindly; follow the record's recovery line |

After step 1 (the eraser role gains sign-in) and after step 3 (the first pg_net install also creates
Supabase's own `supabase_functions_admin` role), the QA sandbox function baseline digest changes, so
the next `qa-sandbox-functions` apply needs a new `baseline-only` run first. That is expected. Step 3
allows exactly that platform role and no other role change.

**pg_net privileges.** On Supabase the `net` schema and its functions belong to `supabase_admin`,
which grants USAGE to PUBLIC, `anon` and `authenticated`; the `postgres` role the deploy uses is
not their grantor and cannot revoke those grants (a REVOKE is a silent no-op). They matter only if
`net` were exposed through the Data API: the owner should confirm in the Supabase dashboard (API
settings, exposed schemas) that `net` is not listed.

Monitoring after the switch is on is in the PostHog runbook: the oldest-due-job query, the
`analytics erasure overdue jobs` line and the `ANALYTICS CAPTURE DEFERRED` line.
