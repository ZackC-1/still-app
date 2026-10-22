# Read-only QA database checks

The dedicated GitHub Actions workflow confirms backend results using only approved QA views.
It defaults to **per-run owner approval**. The owner may instead activate **standing authorization**
for this route using the procedure below (owner decision, 14 October 2026).
Agents never approve runs or change environment protection. This exception does not apply to
production deployments, payment operations, deletion, or arbitrary SQL.

| Piece | Where |
| --- | --- |
| Workflow | [`.github/workflows/supabase-readonly-checks.yml`](../../.github/workflows/supabase-readonly-checks.yml) |
| Closed check catalogue | [`scripts/backend/qa-checks/catalogue.mjs`](../../scripts/backend/qa-checks/catalogue.mjs) |
| Single-SELECT guard / report rendering | [`sql-guard.mjs`](../../scripts/backend/qa-checks/sql-guard.mjs), [`report.mjs`](../../scripts/backend/qa-checks/report.mjs) |
| Runner (Deno) | [`run.ts`](../../scripts/backend/qa-checks/run.ts) |
| Baseline lookup (DB-31, DB-35) | [`baseline.mjs`](../../scripts/backend/qa-checks/baseline.mjs) |
| Database role, registry and views (candidate) | [`scripts/backend/sql/qa-readonly-checks-candidate.sql`](../../scripts/backend/sql/qa-readonly-checks-candidate.sql) |
| Production sales summary view for PROD-01 (numbered migration) | [`supabase/migrations/0025_production_sales_summary_view.sql`](../../supabase/migrations/0025_production_sales_summary_view.sql), gate [`verify/0025_production_sales_summary_view.sql`](../../scripts/backend/deploy/verify/0025_production_sales_summary_view.sql) |
| One-time owner helpers | [`owner-setup.mjs`](../../scripts/backend/qa-checks/owner-setup.mjs) |

## How one check runs

1. Claude starts the workflow from `main`, for example
   `gh workflow run supabase-readonly-checks.yml --ref main -f check=DB-07 -f account=web-chrome -f account_b=none`.
   Inputs are fixed choice lists: a programme id (or `setup`) and the labels below. No SQL,
   email or id can be typed in.
2. In default mode, GitHub holds the run until **the owner** approves it in the
   `supabase-readonly-checks` environment. In activated standing mode, that dedicated environment
   releases only its QA read-only credentials without a per-run approval.
3. The job verifies the dedicated workflow, manual dispatch, main branch, repository, commit and
   attempt against GitHub's run record. Default mode also verifies the exact owner reviewer and
   observed approval; standing mode requires explicit `standing-v1`, no reviewer gates, disabled
   admin bypass and exactly the main branch policy. Unreadable or mismatched protection stops the
   job before database access.
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
   `age --decrypt --identity <private key file> --output <private dir>/report.json <private dir>/report.age`.
   Create the directory with mode 700 and use `umask 077` before download/decryption. Never print
   plaintext reports in a public log, commit them, or paste private identity fields into chat.

`unavailable` means the named account is the optional, unregistered Preserved account; nothing was
read. `pass` and `fail` are decided only where the expectation is exact (route readiness, DB-02, DB-15,
DB-31, DB-32, DB-33, DB-37, a changed production for DB-35, a missing PROD-01 summary row); every
other check is `needs-review`.

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
  or elevated attribute; any grant beyond SELECT on the 25 candidate views plus each migration view
  whose migration is applied (today only 0025's `production_sales_summary`); any writable relation or
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
- **Production accounts are never printed.** DB-01 turns production rights, policy revisions and
  cutoff into one keyed digest (HMAC-SHA-256) and uploads only that digest as artifact
  `qa-production-baseline`; DB-31 and DB-35 recompute it and report "production unchanged since
  baseline: yes / no". They find the newest successful DB-01 run on main that still carries that
  artifact ([`baseline.mjs`](../../scripts/backend/qa-checks/baseline.mjs)) and fail with
  `baseline-not-found` when there is none, so run DB-01 again once its artifact has expired. A
  downloaded baseline file that is malformed fails the check as `baseline-invalid`.
  The one exception is PROD-01 (below): it prints the production sales policy
  facts the public `product-policy` route already serves and the paid cutoff's product
  configuration, in the encrypted report only, and nothing about any account or person.
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
   the views; it changes no existing row, role, grant or policy and is safe to re-run. It
   adds no migration history, so DB-01 and the `qa-sandbox-functions` operation are unaffected.
   Views added later (PROD-01's view, migration 0025) are numbered migrations applied through the
   protected migration operation, never this editor; re-running this file keeps their grant.
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

## Activate or revoke standing authorization

Code compatibility does not mean standing authorization is active. Keep per-run approval until
this merged workflow and guard have passed tests, and a current-mode approved `setup` run succeeds.
The agent must not approve that run, download reports from a pending run, or remove the reviewer.

The owner then makes this one-time change:

1. Confirm the environment is exactly `supabase-readonly-checks`, holds only the two QA read-only
   secrets above, has administrator bypass disabled, and permits the `main` **branch** only.
2. Set the repository Actions variable `STILL_QA_READONLY_AUTHORIZATION` to `standing-v1`.
   This is a fixed configuration value, never a workflow input. Other nonempty values fail closed.
3. Remove the required-reviewer rule from this environment only. Keep main-only deployment
   branches and disabled administrator bypass. No other environment or production rule changes.
4. Dispatch a harmless `setup` check from main. Confirm the protection summary says
   `Authorization: standing-v1`, the role/scope checks pass, and the report is encrypted. Record
   the run URL and configuration verification in the private QA operational record.

Only after step 4 succeeds is standing authorization verified. The transition deliberately fails
closed if the variable and environment disagree. Existing per-run runs remain owner-gated.
For later checks, use the same dispatch/download/private-decrypt procedure above. GitHub records
the initiating actor, triggering actor, attempt, source SHA and closed check/account inputs; the
protection summary records the selected authorization mode. No arbitrary customer identifiers are
accepted. A failed protection or role check must be fixed through reviewed configuration, never
bypassed with a broader credential.

To revoke: restore the owner's required-reviewer rule first, then remove the variable or set it
to `per-run`. Verify a new run waits for owner approval. Do not approve an outstanding run on the
owner's behalf. If credentials are suspect, use the role-disable procedure below as well.
Changing this variable or reviewer rule never changes database grants or deployment permissions.

### Exact approved data scope

Account inputs are the existing labels `web-chrome`, `web-firefox`, `web-android`, `fresh`,
`refund-web`, `qa-a`, `qa-b`, and `delete`. `none` is used for account-free checks; `preserved`
remains unavailable because it is not a registered owner QA alias. The catalogue validates each
check's required account count. It accepts no email, UUID or free-form query.

The role has SELECT on precisely these 25 `still_qa_checks` views from the candidate, plus
`production_sales_summary` once migration 0025 is applied (26 in all), as enforced by
[`CHECK_VIEWS` and `MIGRATION_VIEWS`](../../scripts/backend/qa-checks/sql-guard.mjs):

`account_status`, `qa_subjects`, `profiles`, `settings_writes_summary`, `settings_anchors`,
`entitlements_summary`, `access_rights`, `apple_observations`, `access_observations`,
`access_revocations`, `apple_link_operations`, `purchase_operations`, `negative_rights`,
`sessions_summary`, `rate_limit_summary`, `analytics_subjects_summary`, `migration_history`,
`policy_heads`, `paid_cutoff_environments`, `production_rights_fingerprint`, `rights_summary`,
`isolation_summary`, `retention_summary`, `privacy_summary`, `erasure_jobs_last_hour`; and, from
migration 0025, `production_sales_summary`.

Existing approved catalog metadata reads establish role/schema safety. Production baseline checks
emit only the existing keyed digest. Standing authorization adds no base-table access, membership,
DDL, SECURITY DEFINER execution or writable transaction. The runner rejects missing encryption
configuration and every privilege expansion before executing a check.

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
| PROD-01 | `production-sales` | none | Release check, not a programme step. Production sales head (revision, `expected_revision`, salesEnabled, both offers, builds) and the paid cutoff (present, product, benefits). Needs migration 0025; see below. |

Differences from the programme's draft SQL: account ids come from the registry instead of an email
digest typed per run; right ids are compared by keyed reference instead of being passed in; Stripe
session ids are reported only as "test mode yes/no"; production is compared, never printed;
free-text values are withheld unless they match the declared shape.

## PROD-01: production sales and cutoff summary

PROD-01 answers the go-live runbook's production checks (V17, the sales half of V16 and V74)
without the SQL editor. One run prints, in the encrypted report only:

- **Sales policy:** the newest production sales revision (`none` when there is none: sales are Off),
  `expected_revision` (that revision, or `0` before the first one: the value the next production
  sales operation must name for its compare-and-set), when it was published, `salesEnabled`, and
  each channel's enabled flag and offer (`still-pro-v3`).
- **Approved builds:** one row per surface and build in that revision.
- **Paid cutoff:** whether the write-once production cutoff exists, its product id, its benefit
  list, the sales revision that froze it and when.

The sales facts are exactly what the public `product-policy` route serves; the cutoff is product
configuration. Nothing is read about an account, a right, a purchase, an owner, an operation id or
a preview hash, and there are no counts of people. The public log shows only the one verdict line.
Its verdict is `needs-review` (the right answer depends on the release phase: before go-live expect
no revision, `expected_revision 0` and no cutoff); only a missing summary row is `fail`.

### How the view is installed (decision)

The view, `still_qa_checks.production_sales_summary`, is the reviewed numbered migration
[`0025_production_sales_summary_view.sql`](../../supabase/migrations/0025_production_sales_summary_view.sql),
applied through the protected migration operation, not pasted into the dashboard SQL editor. That
keeps production schema changes on the one owner-approved, rehearsed, verified path the go-live
runbook requires ("never the dashboard SQL editor against production") and records the change in
migration history. The migration:

- creates only that view (owned by `postgres`, `security_barrier`, reading only
  `private.product_policy_revisions` and `private.paid_cutoff`), and the `still_qa_checks` schema
  if it is missing;
- revokes PUBLIC, `anon`, `authenticated` and `service_role`, and grants SELECT to
  `still_qa_readonly_checker` only, and only when that role exists (hosted production has it from
  the candidate). On a disposable database without the role it creates the view ungranted;
  installing the candidate afterwards grants it;
- is forward-only and idempotent, changes no row, role, policy or function, and checks its own end
  state. Its deploy gate
  [`verify/0025_production_sales_summary_view.sql`](../../scripts/backend/deploy/verify/0025_production_sales_summary_view.sql)
  pins the column list, the two tables it reads, the owner, the options and the grants; the row
  invariant fingerprints the policy tables before and after.

Until 0025 is applied, every other check still runs (the runner accepts the 25 candidate grants)
and PROD-01 answers `fail` with "that migration is not applied to this database yet ... Nothing was
read".

Because `qa-sandbox-functions` requires hosted history to equal `main`, apply 0025 in the same
migration sequence as 0022 to 0024 (after 0024), before the next QA function deploy.

### Operator steps (owner)

1. **Install (once).** After 0024 is applied and verified, start `Supabase production deploy` from
   `main` with `commit` = the main commit that contains 0025 (the merge commit of the PR that added
   it, or a later main commit with no newer migration), `operation` = `migrations`, `migrations` =
   `0025_production_sales_summary_view.sql`, `mode` = `plan-only`. Read the plan: one migration,
   its gate and invariant, expected history ending at `0024` before and `0025` after.
2. **Approve.** Run the same inputs with `mode` = `apply` and approve the `supabase-production`
   environment when GitHub asks. The run ends with the gate clean and the row counts unchanged.
3. **Run.** Start `Supabase read-only QA check` from `main` with `check` = `PROD-01`, `account` =
   `none`, `account_b` = `none`; approve it in `supabase-readonly-checks` (or it runs at once under
   standing authorization).
4. **Read.** The public line says `Read-only QA check PROD-01: needs-review`. Claude downloads and
   decrypts `qa-report-<run id>` as in "How one check runs" and reports, in one sentence each: the
   production sales revision and `expected_revision`, salesEnabled and the two offers, the builds,
   and whether the cutoff exists with which product id and benefits.

Undo: none is needed for a read; to remove the view, a later reviewed migration drops it.

## Evidence and limits

Source tests: `node --test scripts/backend/qa-checks/qa-checks.test.mjs` (catalogue, guard,
production never printed except PROD-01's one view, migration 0025's shape, grants and lint-clean
gate, alias rule consistency, output, verdicts, workflow shape and pinning, protection check, owner
helpers), the 0025 plan test in `scripts/backend/deploy/deploy.test.mjs`, and
`deno test … scripts/backend/qa-checks/run.test.ts` (session proof including the before-0025 grant
set, keyed digest, failure text, age encryption round trip). The disposable-database proof,
`scripts/backend/rehearse-qa-readonly-checks.sh`, runs in the `Supabase security rehearsal`
workflow. First it rehearses migration 0025 as production meets it
(`supabase/tests/production_sales_summary_migration_test.ts`): the database at 0024 with the
candidate installed, so the checker role exists; the gate before and after the CLI applies 0025;
unchanged policy rows; wider grants to `anon` or another role caught by the gate and by the
migration's self-check, with the checker present and absent; and a clean re-apply. Then it installs
the candidate twice more and, as the real role, proves alias-only registration, every check,
QA-only visibility, the keyed production comparison, PROD-01 on an empty and a seeded production
policy (and its refusal before 0025's grant), the deletion check, refused reads and writes, and
refusal of every kind of widened role.

Not proven until setup: the hosted install, sign-in through the session pooler and its certificate,
the GitHub environment's protection and a first real `setup` run. Residual risks:

- A holder-less sandbox right that someone else (for example App Review) verifies during the QA
  run is visible to the checks, as a keyed reference only.
- A future migration that changes a column a view uses must recreate that view in the same reviewed
  change; PostgreSQL refuses otherwise, so this fails loudly.
- Platform grants to every role (for example pg_cron's own row-filtered job tables) are outside the
  role's control; read-only transactions make them harmless here.
