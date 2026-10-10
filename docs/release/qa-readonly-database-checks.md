# Read-only QA database checks

During the owner QA programme, Claude needs to confirm that the hosted backend recorded each test
action correctly ("Claude, run DB-07"). The owner chose a **protected read-only check** (decision,
10 October 2026): a GitHub Actions workflow that can only read, where every run waits for the
owner's one-click approval in GitHub, like the production deploy. Claude never uses the Supabase
command-line tool, never holds a write credential and **never approves a run**: the owner clicks
"Approve" in GitHub, the same model as `supabase-production-deploy`.

| Piece | Where |
| --- | --- |
| Workflow | [`.github/workflows/supabase-readonly-checks.yml`](../../.github/workflows/supabase-readonly-checks.yml) |
| Closed check catalogue | [`scripts/backend/qa-checks/catalogue.mjs`](../../scripts/backend/qa-checks/catalogue.mjs) |
| Single-SELECT guard / report rendering | [`sql-guard.mjs`](../../scripts/backend/qa-checks/sql-guard.mjs), [`report.mjs`](../../scripts/backend/qa-checks/report.mjs) |
| Runner (Deno) | [`run.ts`](../../scripts/backend/qa-checks/run.ts) |
| Database role, registry and views (candidate) | [`scripts/backend/sql/qa-readonly-checks-candidate.sql`](../../scripts/backend/sql/qa-readonly-checks-candidate.sql) |
| One-time owner helpers | [`owner-setup.mjs`](../../scripts/backend/qa-checks/owner-setup.mjs) |

## How one check runs

1. Claude starts the workflow from `main`, for example
   `gh workflow run supabase-readonly-checks.yml -f check=DB-07 -f account=web-chrome`.
   Inputs are fixed choice lists: a programme id (or `setup`) and the labels below. No SQL,
   email or id can be typed in.
2. GitHub holds the run until **the owner** approves it in the `supabase-readonly-checks`
   environment. Only then are the environment's secrets released to the job.
3. The job re-checks through GitHub's API that the environment is owner-only (exactly the owner as
   required reviewer, administrators cannot bypass, `main` only) and that the owner approved this
   run; otherwise it stops before touching the database.
4. The runner signs in as `still_qa_readonly_checker`, opens a read-only transaction, proves the
   session is the narrow role, runs the reviewed queries and rolls back.
5. **The repository is public**, so Actions logs, summaries and artifacts are world-readable. The
   log and summary show one line: `Read-only QA check DB-07: pass | fail | needs-review | unavailable`. The full
   report is encrypted with [age](https://github.com/FiloSottile/age) (v1.2.1, checksum pinned) to
   the repository variable `STILL_QA_READONLY_REPORT_PUBKEY` and uploaded as artifact
   `qa-report-<run id>` (kept 14 days). Only Claude's private key opens it.
6. Claude downloads and decrypts it locally, compares it with the programme's "Should be recorded"
   text and tells the owner in one sentence:
   `gh run download <run id> -n qa-report-<run id> -D <private dir>` then
   `age --decrypt --identity <private key file> <private dir>/report.age`.

`unavailable` means the named account is the optional, unregistered Preserved account; nothing was
read. `pass` and `fail` are decided only where the expectation is exact (route readiness, DB-02, DB-15,
DB-31, DB-32, DB-33, DB-37, a changed production for DB-35); every other check is `needs-review`.

QA account labels: `web-chrome`, `web-firefox`, `web-android`, `fresh` (QA-Fresh), `refund-web`
(Refund test (web)), `qa-a`, `qa-b`, `delete` (QA-Delete) are the eight owner QA aliases and must
all be registered. `preserved` (Preserved QA account) is an older account, not a `+stillqa` alias,
so the database refuses to register it; it is optional. A check run with `account=preserved`
answers `unavailable: not registered` (not a failure), and `setup` and DB-02 pass with the eight
aliases and note "preserved: not registered (not a QA alias)". For the programme steps that name
the Preserved account (DB-03, DB-04), record the database check as not available through this
route, or run the same check on another registered account that made the same change.

## Why it can only read, and only QA data

Each layer is independent; any one of them alone stops a write.

- **Closed inputs.** Only catalogue checks exist; the workflow's choice lists equal the catalogue
  (tested). Labels resolve to accounts inside the database, never from an input value.
- **Reviewed single SELECTs.** A guard test proves every query is one plain SELECT with no
  statement separator, comment, write or locking word, unsafe function or base-table reference;
  the runner re-applies it. Queries always use PostgreSQL's extended protocol, which refuses a
  second statement even without parameters.
- **Read-only transaction.** `BEGIN READ ONLY`, local statement and lock timeouts, explicit rollback.
- **Narrow role, re-proved every run.** The runner refuses to read if the role has any membership
  or elevated attribute; any grant beyond SELECT on the 25 check views; any writable relation or
  direct read of a Still, Auth, Storage, migration, registry or scope table; schema or database
  CREATE; EXECUTE on any SECURITY DEFINER function outside `pg_catalog`/`information_schema`
  (reviewed allow-list, currently empty); or any per-role setting other than its six reviewed
  defaults (read-only transactions, timeouts, parameter-free logs).
- **Only owner QA aliases.** A QA alias is a confirmed Auth email of the form
  `<owner local part>+stillqa-<name>@<owner domain>` whose tag-free address matches the owner's
  mailbox digest (`still_qa_checks.qa_alias_owner`). Mail to an alias reaches only the owner, so
  no customer can hold one. The database refuses to register anything else (trigger), and every
  view re-checks the rule at read time; the seven paid-lane labels must also be sandbox members.
  No owner address is committed to the repository.
- **QA-only rows.** Rights are visible only when held by a QA account, linked by one, or holder-less
  sandbox rights verified after the registry was filled (the QA run's start; covers the
  account-less Apple purchase and rights orphaned by deletion). Sandbox totals are sandbox-only;
  erasure jobs appear only as last-hour counts by scope and stage. A synthetic customer, a
  customer's sandbox right, an older holder-less sandbox right and an older erasure job are all
  invisible in the disposable-database test.
- **Production is never printed.** DB-01 turns production rights, policy revisions and cutoff into
  one keyed digest (HMAC-SHA-256) and uploads only that digest as artifact `qa-production-baseline`;
  DB-31 and DB-35 recompute it and report "production unchanged since baseline: yes / no".
- **Keyed references.** Ids appear only as `#` plus 10 hex characters of HMAC-SHA-256 under
  `STILL_QA_READONLY_REF_KEY`, stable across runs so a right can be matched before and after an
  action. The registry's email digests (unsalted SHA-256) are not secret, only not readable at a
  glance; protection comes from the database rule above, not from the digests.

## One-time setup

Claude first creates the report keypair on the owner's computer and keeps the private key there:
`age-keygen -o ~/.config/still/qa-report-age.key` (install `age` with Homebrew if needed; the file
is owner-only), then gives the owner the printed `age1…` public key. The private key is never
committed, pasted into GitHub or sent anywhere.

Owner steps (five):

1. **Install the database part.** Paste the reviewed
   `scripts/backend/sql/qa-readonly-checks-candidate.sql` into the Supabase SQL editor and run it.
   It adds only the new role (no sign-in yet), the `still_qa_checks` schema, an empty registry and
   the views; it changes no existing row, role, grant or policy and is safe to re-run. Migration
   history stays at `0021`, so DB-01 and the `qa-sandbox-functions` operation are unaffected. (A
   numbered migration is possible later, but merge it only when it can be deployed at once: a
   migration on `main` that hosted history lacks blocks `qa-sandbox-functions`.)
2. **Create the sign-in.** On your computer run
   `node scripts/backend/qa-checks/owner-setup.mjs login --project-ref <ref> --pooler-host <session pooler host> --out <new private file>`.
   Paste its step 1 (a password verifier with a 60-day expiry, never the password) into the SQL
   editor. Keep the file for step 4.
3. **Register the QA accounts.** Claude prepares the paste from the private QA account file
   with `owner-setup.mjs registry` (digests only). It needs the eight alias labels; it leaves the
   Preserved account out with a note because it is not an alias. Run block A first: it shows each
   label with a masked address such as `z***+stillqa-refund@…` and `qa_alias = true`. Only if every
   row looks right, run block B. It reports the number it registered (normally 8).
4. **GitHub settings.**
   - Settings → Environments → new environment `supabase-readonly-checks`: required reviewer = only
     you; "Prevent self-review" off (runs start under your account); "Allow administrators to
     bypass" off; deployment branches = selected, `main` only. Add two environment secrets from the
     private file: `STILL_QA_READONLY_DB_URL` and `STILL_QA_READONLY_REF_KEY`. Delete the file.
   - Settings → Secrets and variables → Actions → Variables: `STILL_QA_READONLY_REPORT_PUBKEY` =
     the `age1…` public key from Claude. (Only if the connection reports an untrusted certificate:
     environment variable `STILL_QA_READONLY_CA_PEM` = the database's public CA certificate.)
5. **Approve the first run.** Claude starts `setup`; approve it in GitHub. It passes when the eight
   alias labels are registered, live QA aliases and (for the paid lane) sandbox members. Then run DB-01
   before any testing so the production baseline exists.

## If the credential may have leaked, and routine hygiene

Run in the SQL editor:

```sql
alter role still_qa_readonly_checker nologin;
select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = 'still_qa_readonly_checker';
```

Then delete the `STILL_QA_READONLY_DB_URL` secret. To resume, repeat setup step 2 (new password)
and replace the secret. Even a leaked credential can only read the QA-scoped views.

- **Expiry.** Sign-in expires 60 days after step 2 (`valid until`); repeat step 2 to renew.
- **The role can change its own password and per-role defaults** (PostgreSQL lets every role do
  that). Changed defaults make every later check refuse to read ("role-settings"); a changed
  password locks the workflow out. Either way: run the leak response above, then repeat step 2.
- **Removing the route:** `drop schema still_qa_checks cascade; drop role still_qa_readonly_checker;`
  (no Still data lives there), delete the environment and the variable.

## Programme mapping

| Programme step | Catalogue check | Inputs | Notes |
| --- | --- | --- | --- |
| DB-01 | `baseline` | none | Migration tail, QA members, sandbox policy heads and cutoff; records the keyed production baseline. Run before testing. |
| DB-35 | `baseline-recheck` | none | Same facts plus "production unchanged since baseline". |
| DB-02 | `account-identity` | none | All registered labels in one run (the eight aliases): present, confirmed, banned, deleted, membership, in scope. Preserved is noted as not registered. |
| DB-03, DB-28 | `settings-write` | account | Version, server time, switches, last write logged, anchor, write log. DB-03's Preserved account answers `unavailable`. |
| DB-04 | `settings-merge` | account | Switches plus per-field clocks. Preserved answers `unavailable`. |
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
| DB-29, DB-30 | `account-deleted` | account | Works after deletion because the registry keeps the label's account id; per-table counts, holder-less sandbox rights since the QA start (match DB-21's reference), last-hour erasure counts. |
| DB-31 | `sandbox-isolation` | none | Sandbox totals, isolation counts, production unchanged since baseline. |
| DB-32 | `private-grants` | none | Catalog only. |
| DB-33 | `retention` | none | Counts only. |
| DB-34 | `test-account-markers` | none | Member list by label, whether each is an owner QA alias, counts. |
| DB-37 | `no-browsing-history` | none | Catalog column scan; unknown settings keys and unhashed rate keys as counts. |
| DB-36 | none | n/a | **Not read-only:** rollback, outage, concurrency, speed, restore and alert cases need fault injection or writes. Record engineering's result. |

Differences from the programme's draft SQL: account ids come from the registry instead of an email
digest typed per run; right ids are compared by keyed reference instead of being passed in; Stripe
session ids are reported only as "test mode yes/no"; production is compared, never printed;
free-text values are withheld unless they match the declared shape.

## Evidence and limits

Source tests: `node --test scripts/backend/qa-checks/qa-checks.test.mjs` (catalogue, guard,
production never printed, alias rule consistency, output, verdicts, workflow shape and pinning,
protection check, owner helpers) and `deno test … scripts/backend/qa-checks/run.test.ts` (session
proof, keyed digest, failure text, age encryption round trip). The disposable-database proof,
`scripts/backend/rehearse-qa-readonly-checks.sh`, runs in the `Supabase security rehearsal`
workflow: it installs the candidate twice, then as the real role proves alias-only registration,
every check, QA-only visibility, the keyed production comparison, the deletion check, refused reads
and writes, and refusal of every kind of widened role.

Not proven until setup: the hosted install, sign-in through the session pooler and its certificate,
the GitHub environment's protection and a first real `setup` run. Residual risks:

- A holder-less sandbox right that someone else (for example App Review) verifies during the QA
  run is visible to the checks, as a keyed reference only.
- A future migration that changes a column a view uses must recreate that view in the same reviewed
  change; PostgreSQL refuses otherwise, so this fails loudly.
- Platform grants to every role (for example pg_cron's own row-filtered job tables) are outside the
  role's control; read-only transactions make them harmless here.
