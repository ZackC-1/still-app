# Read-only QA database checks

During the owner QA programme, Claude needs to confirm that the hosted backend recorded each test
action correctly ("Claude, run DB-07"). The owner chose a **protected read-only check** (decision,
10 October 2026): a GitHub Actions workflow that can only read, where every run waits for the
owner's one-click approval in GitHub, like the production deploy. Claude never uses the Supabase
command-line tool and never sees a write credential.

| Piece | Where |
| --- | --- |
| Workflow | [`.github/workflows/supabase-readonly-checks.yml`](../../.github/workflows/supabase-readonly-checks.yml) |
| Closed check catalogue | [`scripts/backend/qa-checks/catalogue.mjs`](../../scripts/backend/qa-checks/catalogue.mjs) |
| Single-SELECT guard / privacy-safe output | [`sql-guard.mjs`](../../scripts/backend/qa-checks/sql-guard.mjs), [`report.mjs`](../../scripts/backend/qa-checks/report.mjs) |
| Runner (Deno) | [`run.ts`](../../scripts/backend/qa-checks/run.ts) |
| Database role, registry and views (candidate) | [`scripts/backend/sql/qa-readonly-checks-candidate.sql`](../../scripts/backend/sql/qa-readonly-checks-candidate.sql) |
| One-time owner helpers | [`owner-setup.mjs`](../../scripts/backend/qa-checks/owner-setup.mjs) |

## How one check runs

1. Claude starts the workflow from `main` with a check id and, where needed, QA account labels,
   for example `gh workflow run supabase-readonly-checks.yml -f check=DB-07 -f account=web-chrome`.
   The inputs are fixed choice lists: a programme id (or `setup`) and the nine labels below. No SQL,
   email or id can be typed in.
2. GitHub holds the run until the owner approves it in the `supabase-readonly-checks` environment.
   Only then is the read-only connection secret released to the job.
3. The job re-checks, through GitHub's API, that the environment is owner-only (exactly the owner
   as required reviewer, administrators cannot bypass, deployments from `main` only) and that the
   owner approved this run. Otherwise it stops before touching the database.
4. The runner signs in as `still_qa_readonly_checker`, opens a read-only transaction with a
   15-second statement timeout, proves the session is the narrow role, runs the reviewed queries
   and rolls back. The log and job summary show counts, yes/no values, states, timestamps and
   short hashed references (`#3f2a…`), never an email, token, Stripe id or raw account id.
5. Claude reads the result, compares it with the programme's "Should be recorded" text and tells
   the owner in one sentence.

QA account labels: `preserved` (Preserved QA account), `web-chrome`, `web-firefox`,
`web-android`, `fresh` (QA-Fresh), `refund-web` (Refund test (web)), `qa-a`, `qa-b`, `delete`
(QA-Delete).

## Why it can only read

Each layer is independent; any one of them alone stops a write.

- **Closed inputs.** Only catalogue checks exist; the workflow's choice lists equal the catalogue
  (tested). Labels resolve to accounts inside the database, never from an input value.
- **Reviewed single SELECTs.** A guard test proves every catalogue query is one plain SELECT with
  no statement separator, comment, write or locking word, unsafe function or base-table reference.
  The runner re-applies the guard at run time.
- **One statement per call.** Queries always use PostgreSQL's extended protocol, which refuses a
  second statement even without parameters.
- **Read-only transaction.** `BEGIN READ ONLY`, local statement and lock timeouts, explicit rollback.
- **Narrow role.** `still_qa_readonly_checker` belongs to no role, has no elevated attribute, has
  read-only transactions and a 15-second timeout by default, and hides query parameters from logs.
  Its only grants are SELECT on the `still_qa_checks` views. The runner refuses any session with a
  membership, an extra grant, a writable relation or a direct read on a Still, Auth, Storage or
  migration table.
- **QA-only data.** The views run as their owner and return only the nine registered QA accounts,
  the sandbox QA members, sandbox rights (test purchases by definition) and whole-database counts
  or fingerprints. A synthetic customer is invisible in the disposable-database test.
- **Protected secret.** The environment holds only the read-only connection URL. No other workflow
  may name the environment or the secret (tested).

## One-time owner setup

Nothing here is done by Claude; each step is an owner action.

1. **Approve and install the database part.** Review
   `scripts/backend/sql/qa-readonly-checks-candidate.sql`. It creates only the role (no sign-in
   yet), the `still_qa_checks` schema, an empty registry and the views; it changes no existing row,
   role, grant or policy, and re-running it is safe. Two ways to install, decided by the owner:
   - *Recommended during QA:* paste the reviewed file into the Supabase SQL editor (the same
     route the reviewed security-audit role candidate uses). Migration history stays at `0021`, so
     DB-01's baseline and the fixed `qa-sandbox-functions` operation are unaffected.
   - *Protected deploy:* a separate PR numbers it as the next migration with verification files,
     then a `supabase-production-deploy` run applies it. Merge that PR only when it can be deployed
     straight away: a numbered migration on `main` that hosted history lacks blocks the
     `qa-sandbox-functions` operation, and DB-01 then expects the new number.
2. **Turn on sign-in for the role.** On your computer:
   `node scripts/backend/qa-checks/owner-setup.mjs login --project-ref <ref> --pooler-host <session pooler host> --out <new private file>`.
   Paste line 1 of that file (a password verifier, not the password) into the SQL editor. Keep the
   file for step 4, then delete it.
3. **Register the nine QA labels.** Claude prepares the statement from the private QA account file:
   `node scripts/backend/qa-checks/owner-setup.mjs registry < <private label-to-email JSON>`.
   It contains only email digests. Paste it into the SQL editor; it must report 9.
4. **Create the GitHub environment** `supabase-readonly-checks` (Settings → Environments):
   required reviewer = only you; "Prevent self-review" off (Claude starts runs as your account);
   "Allow administrators to bypass" off; deployment branches = selected branches, `main` only.
   Add one environment secret, `STILL_QA_READONLY_DB_URL`, from line 2 of the private file. If the
   connection is refused for an untrusted certificate, add the database's public CA certificate as
   environment variable `STILL_QA_READONLY_CA_PEM`; never weaken verification.
5. **Prove the route.** Ask Claude to run `setup`, approve it, and confirm it lists all nine labels.

**Turning it off:** delete the environment secret (fastest), or in the SQL editor run
`alter role still_qa_readonly_checker nologin;`. Removing the route entirely is
`drop schema still_qa_checks cascade; drop role still_qa_readonly_checker;` (no Still data lives
there; the registry holds only label-to-account links).

## Programme mapping

| Programme step | Catalogue check | Inputs | Notes |
| --- | --- | --- | --- |
| DB-01, DB-35 | `baseline` | none | Migration tail, QA members, policy heads, cutoff, production fingerprint (16 hex). |
| DB-02 | `account-identity` | none | All nine labels in one run: present, confirmed, banned, deleted, membership. |
| DB-03, DB-28 | `settings-write` | account | Version, server time, switches, last write logged, anchor, write log. |
| DB-04 | `settings-merge` | account | Switches plus per-field clocks. |
| DB-05 | `first-sign-in` | account | Profile/entitlement/right counts and schema version. |
| DB-06 | `settings-isolation` | account, account_b | Document fingerprints and distinct count. |
| DB-07, DB-10, DB-38 | `checkout-started` | account | Operations (test-mode session shown as yes/no) and open count. |
| DB-08 | `checkout-cancelled` | account | Operations and rights count. |
| DB-09, DB-12, DB-21 | `web-purchase` | account | Operations, rights, legacy entitlements. Keep DB-21's right reference for DB-30. |
| DB-11 | `account-switch` | buyer, fresh | First label is the buyer. |
| DB-13, DB-14 | `apple-accountless` | none | Apple sandbox rights verified in the last 30 minutes; run soon after the purchase. |
| DB-15 | `no-purchase` | account | Rights and operations counts. |
| DB-16, DB-18 | `restore-refresh` | account | Rights with verified time; observations. |
| DB-17 | `apple-link` | account | Rights and link operations. |
| DB-19 | `sign-in-no-move` | qa-a, qa-b | Compares the right's reference with DB-17's output instead of taking right ids. |
| DB-20 | `transfer` | qa-a, qa-b | Second account's rights, link operation, revocations, sandbox transfer count. |
| DB-22 | `refund-revokes` | account | Re-run every 5 minutes until refunded. |
| DB-23 | `pro-choices` | account | Sites switches; rights and active rights. |
| DB-24 | `refund-twice` | account | Negative rights and revocations counts. |
| DB-25 | `rebuy` | account | Operations, rights, negative rights. |
| DB-26, DB-27 | `sign-out` | account | Session count, settings version, active rights. |
| DB-29, DB-30 | `account-deleted` | account | Works after deletion because the registry keeps the label's account id; per-table counts, holder-less sandbox rights (match DB-21's reference), erasure jobs. |
| DB-31 | `sandbox-isolation` | none | Whole-database counts and the production fingerprint. |
| DB-32 | `private-grants` | none | Catalog only. |
| DB-33 | `retention` | none | Counts only. |
| DB-34 | `test-account-markers` | none | Member list (by label) and counts. |
| DB-37 | `no-browsing-history` | none | Catalog column scan; unknown settings keys and unhashed rate keys as counts. |
| DB-36 | none | n/a | **Not read-only:** rollback, outage, concurrency, speed, restore and alert cases need fault injection or writes. Record engineering's result. |

Differences from the programme's draft SQL: account ids come from the registry instead of an email
digest typed per run; right ids are compared by short reference instead of being passed in;
Stripe session ids are reported only as "test mode yes/no"; free-text values are withheld unless
they match the declared shape.

## Evidence and limits

Source tests: `node --test scripts/backend/qa-checks/qa-checks.test.mjs` (catalogue, guard, output
privacy, workflow shape, protection check, owner helpers) and
`deno test --config supabase/functions/deno.json scripts/backend/qa-checks/run.test.ts`. The
disposable-database proof, `scripts/backend/rehearse-qa-readonly-checks.sh`, runs in the
`Supabase security rehearsal` workflow: it installs the candidate twice, then runs every check as
the real role against synthetic QA accounts and a synthetic customer, and proves base-table reads,
registry reads, writes and widened roles are refused.

Not proven until the owner sets it up: the hosted install, sign-in through the session pooler and
its certificate, the GitHub environment's protection, and a first real `setup` run. A future
migration that changes a column used by a view must drop and recreate that view in the same
reviewed change; PostgreSQL refuses the change otherwise, so this fails loudly, never silently.
