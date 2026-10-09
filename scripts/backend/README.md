# Backend security rehearsal

This is the credential-free U1 inventory/assertion/rehearsal slice. Production apply is unavailable.
The unnumbered U1 SQL candidates change privilege reachability in synthetic CI; they do not change
rights. The settings schema is numbered migration 0015 (see "Settings server migration" below).

Run `node --test scripts/backend/plan.test.mjs` for immutable source/target/scope checks. The actual
SQL test requires the new `Supabase security rehearsal` GitHub job. `rehearse.sh` refuses the owner
Mac. It creates a disposable cloud Supabase runtime, applies the real migrations, checks upgrade
preservation/free sync/server JWT and webhook paths, injects unsafe grants **after** hardening and
requires final assertions to fail, then destroys its data. Cleanup also runs on job failure. No
production secrets or customer data enter this job, its plan or its logs. A failed/skipped cloud
test is not evidence that SQL safety passed. Synthetic RevenueCat responses do not certify a provider.

The rehearsal supplies an explicit generic event-trigger descriptor through
[catalog-reconciliation.sql](sql/catalog-reconciliation.sql) and
[synthetic-catalog-fixture.sql](sql/synthetic-catalog-fixture.sql). Owner-only
reconciliation tables hold exact routine owner, language, return type,
configuration, body and trigger owner/bindings, including tags and enabled
state. Every audit compares the whole descriptor; absent, changed or additional
event-trigger routines fail. Ordinary RPCs sharing a fixture name receive no
exemption. The audit role receives fixed issue categories and cannot read these
raw descriptors.

Creator reconciliation combines selected application owners, explicitly reviewed
deployment creators and observed public default-ACL creators, including roles
with no selected objects. Hardening retains observed creator names before
removing their last public ACL entry, so subsequent global drift stays visible.
Global defaults applying to public are checked alongside additive public schema
defaults; default ACLs scoped solely to other schemas do not expand creator
selection or schema revocations. The generic fixture also proves an unrelated
schema's explicit defaults survive.

The new SQL probes check exact application policy definitions and deny-default
rate-limit access, provider preservation/drift, creator-default creation and
later drift, and raw-metadata access restrictions. They preserve the existing
free-sync, writer, rule, JWT, webhook and rollback probes. The disposable cloud
container creates the explicitly privileged synthetic administrator `u1_catalog_fixture`
for event-trigger DDL and creator-default hardening in both the Deno and pgTAP setup.
The pinned Supautils runtime assigns the generic event-trigger binding to `supabase_admin`;
that owner is declared literally in the synthetic descriptor, alongside the complete
reviewed function/configuration/body/binding/tags/enabled state. No live catalog is accepted
as approval. Before administrator apply, the real non-superuser `postgres` connection
must reject hardening with SQLSTATE `42501` at that creator-default authority boundary.
The probe compares pre/post schema/table/column/routine/default ACLs, creator reconciliation,
provider state and role memberships, and requires earlier synthetic writes/grants to roll back.
Ordinary application/admin, client, free-sync and writer probes retain their existing roles;
no `postgres` elevation or new broad membership supplies the missing authority.
This is administrator synthetic evidence only. This login never appears in production/audit
configuration. Local driver/check success and ignored SQL tests do not establish a cloud SQL
pass or production execution-role readiness.

Before a production candidate can be assigned or protected production apply enabled:

1. Run [inventory.sql](sql/inventory.sql) in the actual hosted SQL editor as a read-only owner action. It is a single SELECT returning bounded JSON for the SQL editor,
   supports older membership catalogs, and reports possibly truncated sections.
   Keep the catalog result private. It reads migration versions/names, observed routine hashes,
   direct table/column/function/schema ACLs, global/schema defaults, object owners and membership
   options. It never reads customer rows. Reconcile the actual deployment creator roles separately;
   object ownership does not prove historical creator identity.
2. Return only privacy-safe catalog evidence and the current creator roles. Reconcile grants with
   legitimate operations; do not treat a historical one-grant expectation as the desired state.
   Match actual migration history and a trustworthy deployment ledger. A migration list and current
   routine-definition MD5 alone do not prove the originally applied SQL bytes.
3. Assign a unique migration after that inventory, adapt the narrowly reviewed candidate and repeat
   real cloud positive/negative tests. Unrecognized legitimate SECURITY DEFINER paths must be
   explicitly reviewed; failed assertions must not be bypassed to make the candidate pass.
   Establish that the exact protected production execution role has the required authority for
   every selected creator/default ACL and operation. That authority remains unavailable evidence;
   the privileged synthetic administrator cannot satisfy this production gate.
4. Verify the public GitHub production environment exists with the owner as required reviewer,
   actual owner approval of the exact operation and main-only trusted deployment branches.
   The single owner may initiate and approve; a distinct initiator or prevention of
   self-review is not mandatory. Directly verify and attest that admin bypass
   cannot skip the required approval before production credentials are obtained. Verify
   those protections directly before execution. Merely naming an environment in YAML
   would not establish protection. Planning/PR jobs must never receive writer/admin secrets.
5. Build the protected apply job only around the exact approved operation, target, source hashes,
   trustworthy baseline/ledger, intervening-state comparison and post-change meaningful checks.
   Production credentials arrive only after actual reviewer approval. Runtime secret changes stay
   owner-manual. Even unchanged function redeployment requires its own exact approval.

Recovery preserves the security boundary: stop on any partial failure, leave payments disabled,
record the actual applied subset privately and obtain review of a forward repair. Do not restore
old grants or entitlement/settings data to undo a rollout. This slice tests atomic SQL rollback,
not universally lossless multi-function deployment reversal.

The weekly audit is a separate catalog-only routine/role candidate. The owner must review and
install it after the above evidence, then configure only the dedicated audit login credential and
restricted send-only email credential in its main-only audit environment. Do not reuse the database
owner, service role, entitlement writer or provider admin token. Scheduling alone proves no access
boundary; a successful real audit and delivered test alert remain owner/provider gates.
The workflow runs only when the GitHub Actions configuration variable
`STILL_SECURITY_AUDIT_ENABLED` matches `true` (case-insensitive). Review every configuration scope
visible to the `vars` context before activation. Enable it only under the exact approved audit
operation after installation, environment protection and credential-scope review. Missing/disabled
activation is an unavailable operational gate, never a successful audit. Do not configure the
variable as part of source implementation.
The audit verifies the database certificate and hostname even if its URL requests weaker TLS.
Use the system trust store by default; when the reviewed endpoint needs a dedicated CA, configure
its public PEM certificate in `STILL_SECURITY_AUDIT_CA_PEM`. Never disable verification to fix a
connection failure. Explicit PG environment permissions cover the pinned driver's default reads;
they do not grant this job any writer or owner credential.

CLI commands are pinned to Supabase 2.119.0, checked against the
[official CLI reference](https://supabase.com/docs/reference/cli/supabase-start) and
[release](https://github.com/supabase/cli/releases/tag/v2.119.0). Cloud compatibility is unverified
until that workflow actually runs.

Deno is pinned to [2.8.3](https://github.com/denoland/deno/releases/tag/v2.8.3);
[setup-deno](https://github.com/denoland/setup-deno) accepts exact version inputs.
The [GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
lists Ubuntu 24.04. The rehearsal records the actual CLI binary SHA-256 before execution.

## Exact-operation source foundation

`supabase-deploy.yml` runs a credential-free preview and cloud synthetic lifecycle on pull requests.
It names no environment, references no production secret and never deploys; its former sealed
`protected-apply` placeholder job was removed. The only production path is the manual-dispatch
`supabase-production-deploy.yml` (`scripts/backend/deploy/`): a secret-free plan job binds one exact
commit and migration list and rehearses it on a throwaway database, then the `supabase-production`
environment's owner approval releases the database URL to an apply job that re-derives the plan,
refuses stale main, unexpected history or a differing dry run, applies, and verifies read-only.
Failures stop and need a reviewed fix-forward; there is no automatic rollback.

The existing rehearsal remains unchanged. The new workflow first runs its real migrations,
SQL assertions, pgTAP and handler controls against synthetic data in a disposable cloud runtime.
Then `approved-operation.mjs cloud-synthetic` creates a second disposable runtime, applies the real
migrations, and exercises a dedicated `cp033_fixture` SQL row. This fixture is not the production
security catalogue or deployment ledger. Its two fixed operations retain the denied-role boundary
and record verification; callers cannot supply SQL, commands, function names or database URLs.

Before any synthetic write, the preview binds the immutable revision, all rehearsal source bytes
(including the new workflow), manifest artifact digest, exact fixed operation subset, observed SQL
baseline and GitHub run/attempt. The apply path rehashes source, compares intervening state, locks
the SQL row and compares the complete baseline within the write transaction. After each step it
reads the row and verifies actual denied schema/table privileges. Exit status alone is insufficient.
Changes invalidate the operation digest. The generic in-memory adapters in unit tests are only
test doubles; the callable cloud adapter uses actual PostgreSQL transactions and readbacks.

The cloud negative control commits the first step, deliberately fails the second transaction,
confirms the retained state, and stops the old operation. A new synthetic preview binds that actual
partial state for the remaining forward step. This is a simulated review, never owner approval.
It also injects an independent SQL write between read and locked apply, requiring the database CAS
to reject that operation before confirming any step.
Cleanup runs in the helper's `finally` and the workflow's `always()` step; both assert removal of
the database container and data volume. Cloud execution still requires actual hosted CI evidence.
Local Node tests do not pass these SQL or cleanup gates.

Run the meaningful local contract controls with:

```bash
node --test scripts/backend/plan.test.mjs scripts/backend/approved-operation.test.mjs scripts/backend/entrypoints.test.mjs scripts/backend/hardening-candidate.test.mjs
```

The helper refuses `cloud-synthetic` on the owner Mac before invoking Docker or Supabase. Real
production execution is unavailable on every host. The source has no production adapter or
credential acquisition callback; neither plan nor public PR jobs can request writer credentials.

## Production integration and exact remaining evidence

Complete these gates within the existing protected authority before proposing a real apply:

1. **Actual GitHub protection:** Reverify the real environment identity and sole owner required
   reviewer, trusted `main` branch policy, environment-only credential scope and actual bypass
   settings. Do not auto-create an environment from a YAML reference. The read-only
   `readGitHubProtection` collector checks the documented environment, branch-policy, workflow-run
   and review-history endpoints; missing permissions/fields, extra allowed reviewers or branches,
   wrong source or a non-exact approval fail. It makes only unauthenticated public GET requests.
   It cannot certify disabled administrator bypass: the official environment response schema does
   not include that field. Obtain direct current GitHub configuration attestation; never invent a
   REST property or interpret absence as disabled. Collector success still returns
   `productionReady: false`, and cannot unlock the production refusal.
2. **Exact real target and audited baseline:** Supply the privately reconciled target identity,
   actual migration/function inventory, legitimate creator/role/provider paths and trustworthy
   applied-content provenance. Historical migration names/list/dry-run and current routine hashes
   alone do not prove originally applied bytes. Keep raw descriptors, private hashes and customer
   records outside public plans/logs/artifacts. No baseline is synthesized from missing history.
3. **Concrete tested operation:** Assign the unique next migration only after that inventory, define
   the exact migration/function artifacts and tool versions, rehearse compatibility and intended
   authorized/denied behavior, then bind approved expected state and post-change readbacks. Runtime
   secrets remain owner-manual; unchanged function redeployment still needs its own approval.
4. **Actual owner approval and credentials boundary:** Display the exact tested plan privately and
   obtain the owner review of that run/operation. The collector's bounded exact review comment is
   `CP033 <operation-digest>`, tied to the environment ID, owner ID, run ID, revision and repository.
   An approval-looking caller JSON, synthetic receipt or merge is never authority. Only after
   actual required-reviewer protection and trusted target/ref/state checks may an integrated
   protected job receive environment-only least-privilege production credentials. Public jobs must
   retain no production/write secret references. Recheck the actual protections and baseline before
   writing; drift requires a new preview and approval.

GitHub documents that environment secrets remain unavailable until a required reviewer approves
the environment job in its [environment reference](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
The readback fields and endpoints are documented in the official
[environment API](https://docs.github.com/en/rest/deployments/environments),
[branch-policy API](https://docs.github.com/en/rest/deployments/branch-policies),
[workflow-run/review-history API](https://docs.github.com/en/rest/actions/workflow-runs), and
[public OpenAPI schema](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json).
No custom approval service or plan upgrade is needed. GitHub's supported `prevent_self_review`
field is reported as an observation; enabling it is not required by this contract.

## Partial failure and forward repair

Stop at the first failed apply, source/state mismatch or missing readback. Record only the reviewed
operation ID, exact attempted/confirmed subset, verification outcomes and known/unknown state;
retain raw operational evidence privately. A failed command can have committed changes, so never
infer rollback from failure. The helper records a state digest only after an actual read and reports
security as observed only after actual verification. Missing readback remains unknown.

Keep payment activation disabled and preserve the tightened privilege boundary, valid rights and
settings data. Do not restore old grants or delete entitlement/settings rows. Inspect actual
migration/function state, prepare a forward repair bound to that observed state, rerun relevant
positive/negative rehearsal and compatibility tests, then obtain a new exact owner approval.
Resume only the reviewed remaining steps and verify final authorized/denied behavior. If the
state or safe repair cannot be proven, leave apply unavailable and recover through the reviewed
incident process. This contract makes no universally lossless rollback promise.

## Settings server migration (0015)

`supabase/migrations/0015_settings_sync_per_field.sql` is the numbered server side of the
authenticated `sync-settings` consumer, promoted from the reviewed unnumbered candidate and applied
by the ordinary `postgres` migration role (it refuses any other executing role). It keeps canonical
profiles and private per-account HMAC identity locked in the same PostgreSQL transaction while the
maintained WebCrypto verifier and shared preserving migrator and field ordering execute.
`still_settings_writer` has helper/rate-limit EXECUTE only, no settings/entitlement table access or
client membership; the only membership in it is the automatic non-inheriting admin grant PostgreSQL
records for its CREATEROLE creator. The migration ends with a fail-closed self-check in the style
of 0014 and is idempotent. Production login/password configuration and the function deployment are
separate owner-approved steps; `deploy/verify/0015_settings_sync_per_field.sql` is its read-only
post-apply check.

Free sync for released apps keeps its 0012 behaviour: any signed-in account may write any JSON
object, the row is replaced, the version increments and database time is stamped; there is no
write-id deduplication or timestamp arbitration on that path. 0015 adds one guard: the legacy RPC
takes the same per-account lock as the writer path and then refuses, with
`settings client upgrade required` (40001) and no change, an account that has saved through the
per-field path, whose stored document carries a `schemaVersion` other than 1, or whose incoming
document carries a `schemaVersion` other than 1. The stricter
coarse-write grammar and timestamp arbitration in the earlier candidate were not adopted, because
they would have refused writes that released apps make today (for example from a device whose
clock runs ahead of the server).

Every SECURITY DEFINER function in `public` and `private`, and every function in `private`, uses
`set search_path = pg_catalog, pg_temp`. An empty search_path is not enough: PostgreSQL still
searches the caller's own temporary schema first for type names, so any session that can call a
definer could plant a `pg_temp.text` (or `jsonb`, `uuid`, ...) domain whose CHECK would run with the
owner's rights. 0015 re-pins the 0013/0014 definers it does not replace and its self-check refuses
any definer whose path does not end in `pg_temp`. Later migrations must use the same form.

### Deploy order

0014 must be deployed and verified on its own before 0015. 0014's post-apply check pins the
free-sync body, the limiter's grantees and the empty search_path, all of which 0015 deliberately
changes, so a single run listing both would fail 0014's check after applying. The deploy planner
(`deploy/deploy.mjs`) refuses any plan in which a later listed migration changes a routine that an
earlier listed migration's post-apply check names (category `verification-overlap`). The check reads
the SQL text, so it is best-effort: quoted identifiers, `ALTER ROUTINE`, dynamic SQL and similar forms are
not recognised, and the earlier migration's post-apply check is still the final safeguard. Deploy 0014
from its own commit, confirm it verified, then deploy 0015 alone. Re-running 0014's check after 0015
reports those changes; that is expected and not a regression.

### Owner steps after 0015 is applied (separate approval, never in Git)

1. Give the writer a login without putting a cleartext password in SQL text. Either connect with
   `psql` as `postgres`, run `alter role still_settings_writer login;` and then
   `\password still_settings_writer` (psql hashes the password client-side before sending it), or
   generate a SCRAM verifier offline and run `alter role still_settings_writer login password
   'SCRAM-SHA-256$4096:<salt>$<stored key>:<server key>';`. Never paste a real password or verifier
   into a document, commit, ticket or chat.
2. Build `SETTINGS_WRITER_DB_URL` for the project's connection pooler (Supavisor), whose user name
   is `still_settings_writer.<project-ref>`, and store it only as an Edge Function secret. It never
   goes into a repository file, a workflow log or another function.
3. Before deploying `sync-settings`, connect once as the writer through that pooler URL and run
   `show log_parameter_max_length;` and `show log_parameter_max_length_on_error;`. Both must return
   `0` (and `show statement_timeout;` returns `2s`). If either differs, stop: the private anchor key
   could reach database logs.

### Pausing and resuming new settings sync (owner-approved operations)

`sync-settings` reaches the database only as `still_settings_writer`. The protected
`Supabase production deploy` workflow therefore offers two operations next to its migration mode
(`deploy/operations.mjs`):

- `pause-settings-sync`: `alter role still_settings_writer nologin;`, then closes that role's open
  connections (`pg_terminate_backend`, waiting up to 5 seconds each). Apps keep every setting on the
  device and retry; blocking is unaffected; nothing is deleted.
- `resume-settings-sync`: `alter role still_settings_writer login;` (the password is untouched).
- `pause-qa-sandbox` / `resume-qa-sandbox`: the same pair for `still_qa_sandbox_writer`, the only
  login of the paid `qa-sandbox-*` functions. A pause makes every paid QA function answer
  "unavailable" at once; free sync, live functions and real customers are untouched.

Each runs alone (never with a migration or function), from `main`, with the same plan, owner
approval and closing record as a migration. The SQL bytes must equal the hash pinned in
`operations.mjs`, and every statement must name only the operation's own writer. The plan job
rehearses it on a throwaway database: the writer's sign-in is refused (pause) or allowed (resume),
its open connection is closed, every other function role (`still_entitlement_writer`,
`still_policy_reader`, `still_policy_admin` and the other writer) still signs in, and no other role
fact, grant, row or migration changes. After the apply, read-only
checks confirm the end state (for a pause, again after 30 seconds) and that only the writer's login
changed among all roles. Repeating an operation whose end state already holds reports "already
paused" or "already resumed" and writes nothing. Neither adds migration history.

Per-field write identities retain their original JSON for 30 days within the settings domain.
Database admission allows at most 120 new identities in a rolling minute, 4,096 retained
identities and 4 MiB of retained request JSON per account. Exact retained retries bypass
new-identity admission; full budgets reject new writes atomically without evicting unexpired
identities. The trusted minute schedule physically deletes up to 4,096 expired identities per
sweep, including inactive accounts. Expired retries use their original stamps and cannot
receive a new rank. Account deletion cascades anchors and identities. Unsupported/malformed
canonical data produces a typed hold and is never treated as empty.

Canonical validation covers every maintained field and stamp, shared structural bounds,
future known bases and safe revision saturation. Source-equality checks and raw-input SQL probes
guard this compatibility boundary. Modern SQL applies known values/stamp coordinates onto the
original database JSON; opaque numeric and stamp members are not rewritten through JavaScript's
rounded representation. The CAS baseline uses original database JSON text. Numbers outside the
shared numeric domain return a typed hold.
The final PostgreSQL overlay is validated again against the complete canonical grammar
before the profile write. A bounds hold rolls back the claimed identity as well as the
profile mutation, so an unchanged request can retry when independently retained data fits.

Authenticated bodies are limited to 16 KiB and five seconds; abort starts reader cancellation
and always releases its lock. Settings transactions use one-second lock, two-second statement
and five-second idle transaction deadlines, with request abort propagated to pending queries.
The account serialization lock permits FK key-share reads while still excluding deletion.
The dedicated role suppresses normal/error bind-parameter logging; the disposable runtime also
checks that separate audit parameter logging is disabled. Production logging/provider authority
still requires target verification and approval.

The read-only `supabase-settings-rehearsal.yml` job starts Supabase only on an ephemeral hosted
runner. A successful run must establish 0015 applied by the ordinary migration role both as an
upgrade from 0014 with realistic released-app rows (`settings_sync_migration_seed.sql`) and on a
clean head (`settings_sync_migration_test.ts`), private/narrow grants, authenticated SQL adapter
operations and actual
Supabase CLI function serve with function-specific import aliases. Runtime source outside
`supabase/functions` is included in the immutable plan digest and checked against Deno's actual
resolved graph, including dropped/added dependency controls and the pinned CLI's raw-specifier
aliases. Authenticated readiness must carry the exact env-file process marker; invalid JWT
requests must be rejected before that marked function process. The function-specific external
imports pin the reviewed versions in the shared Deno lock, and the actual resolved dependency
graph is checked against that lock. SQL lifecycle and served CLI assertions live in separate
`settings_sync_test.ts` and `settings_sync_served_test.ts` files. The measured twenty-field write
asserts every value and stamp, exactly one revision increment, durable readback, and unchanged
retained identity/profile state throughout the measured exact retries. EXIT and final workflow cleanup
read back the targeted container/volume labels; passing normal cleanup does not prove the
cancellation path unless cancellation was actually exercised. A separate hosted TERM probe
waits for the authenticated CLI contract, then checks process and targeted runtime removal.
Seeded SQL probes report observed request timings and assert released transactions/connections
after success, retries, holds, statement/lock timeouts and cancelled lock waits. HTTP cancellation
reports whether the caller aborted and database work returned to baseline; it does not attribute
release to request-abort propagation when the configured lock deadline could also explain it.
Parser/local double tests
do not establish these hosted runtime outcomes.

Local checks use `deno check --frozen --config supabase/functions/deno.json
supabase/functions/sync-settings/index.ts` and `deno test --frozen --config
supabase/functions/deno.json supabase/functions/sync-settings/handler.test.ts`. Parse both SQL and
PL/pgSQL bodies with maintained `pglast` before publishing. Hosted checks use
`bash scripts/backend/rehearse-settings.sh <exact revision> <source digest>` with a
`$RUNNER_TEMP/u3-plan.json` created by `plan.mjs`. Never run Docker or a database on the owner's Mac.

This migration does not complete U2/U3/U4: browser/native atomic writers, session-generation
fences, pending acknowledgement integration, same-account raw CAS repair, compiled native
vectors and the effective access/proof resolver remain separate required integrations. Expanded
client persistence stays unexposed until server compatibility protections and full reviews pass.

## Product policy store (0016)

`supabase/migrations/0016_product_policy.sql` adds the server side of the remote `sales` and
`rating` switches (U6): four owner-only tables in `private` (the owner allowlist, the operation
ledger, the append-only published revisions and the write-once paid cutoff), two narrow roles and
four SECURITY DEFINER routes. `still_policy_reader` may only read the current published body
(`supabase/functions/product-policy`); `still_policy_admin` may only preview, apply and read back as
an allowlisted owner (`supabase/functions/product-policy-admin`). Neither role holds any table
privilege, and no client role or `service_role` reaches any of it. The migration writes no row: a
missing policy is Off on every client, and the post-apply check proves the allowlist is empty and no
policy or cutoff exists.

Stored bodies use exactly the shared grammar in `packages/shared-types/src/product-policy.ts`, in one
canonical key order with no whitespace. The database re-checks the grammar and requires a body to
equal its own canonical rendering, so a duplicate key, escape, unknown key, free string or URL is
refused there too. A sales body is only the remote second key; packaged builds AND it with their
compiled `PAID_TIER_ENABLED`, which stays false.

Owner flow: `preview` (verified, unexpired owner JWT; subject on `private.product_policy_owners`;
exact draft; actual expected revision) returns an operation id, a preview hash and a five-minute
expiry. `apply` submits that exact operation; the database compares-and-sets the revision under a
per-namespace/environment lock (one of two parallel applies answers `stale`), is idempotent per
operation id (a retry after a lost reply returns the committed result, even after expiry) and never
reuses an operation for a changed hash or body. The function reports success only after an
authoritative readback matches; otherwise it answers `checking` and the owner retries the same
apply. `preview-rollback` republishes an earlier revision's values at the next revision; revisions
never decrease and published revisions cannot be changed or deleted.

No paid activation is possible from 0016, and that does not depend on function code: the database
refuses every non-null cutoff argument (`product policy cutoff not enabled`), and a sales body that
would let an allowlisted build start a purchase, with no cutoff on record, answers
`cutoff_required` and writes nothing. A future, separately reviewed migration enables the one
write-once cutoff per environment. Before it does, the snapshot must appear in the owner preview and
be bound into the preview hash; today it is in neither (moot while every snapshot is refused).
`product-policy-admin/cutoff.ts` stays `null` until the owner answers which features were released
free and which protected product id to record.

The write-once triggers on `product_policy_revisions` and `paid_cutoff` are `ENABLE ALWAYS`, so a
session with `session_replication_role = replica` still cannot update, delete or truncate them. The
table owner (`postgres`, the migration role) can still drop or alter the tables or triggers; that is
an accepted, documented risk, and the post-apply check proves the triggers are present, always
enabled and unconditional.

### Deploy order

0015 must be deployed and verified on its own before 0016. 0015's post-apply check enumerates the
`private` schema exactly, so it reports 0016's objects; a single run listing both would fail 0015's
check after applying. 0016 revokes execution on every function in schema `private` from the client
roles; the planner reads that schema-wide statement as changing every private routine that 0015's
check names, so its `verification-overlap` rule refuses any plan listing 0015 and 0016 together
(proved against the real files in `deploy/deploy.test.mjs`). Deploy 0016 alone after 0015 verified.
Re-running 0015's check after 0016 reports the new private objects; that is expected.

### Owner steps after 0016 is applied (separate approvals, never in Git)

1. Give `still_policy_reader` and `still_policy_admin` logins exactly as for the settings writer
   (`\password` in psql or an offline SCRAM verifier; never a cleartext password in SQL text).
2. Store `PRODUCT_POLICY_READER_DB_URL` (reader) and `PRODUCT_POLICY_ADMIN_DB_URL` (admin) as Edge
   Function secrets, through the pooler user `<role>.<project-ref>`. Supabase Edge Function secrets
   are project-wide: every deployed function can read every secret, so a code-execution flaw in any
   function exposes both URLs. The separate database roles limit what each credential can do in SQL
   (the reader can only read the current body; the admin can only act through the owner routes,
   which check the allowlist); they do not protect a leaked environment.
3. Deploy `product-policy` and `product-policy-admin` (each its own approved function deploy).
   `supabase/config.toml` pins their gateway settings: `product-policy` has `verify_jwt = false`
   (a public, identity-free read; clients never send a session token), and `product-policy-admin`
   has `verify_jwt = true` (owner-only; the function also verifies the token's expiry, role and
   project issuer, and the database checks the allowlist).
4. Add the owner's own account to the allowlist with one reviewed statement,
   `insert into private.product_policy_owners (user_id) values ('<owner uuid>');`, as its own
   approved operation. Removing an owner is the matching single-row delete.

Nothing here publishes a policy. The first owner apply is itself a separate, explicitly approved
operation; until then every client reads Off.

### Scoped access and Apple migrations (0019, 0020)

Deploy `0019_scoped_access_rights.sql` alone and verify its exact end state, then deploy
`0020_apple_scoped_access.sql` as a separate reviewed operation. The accepted deployment planner
refuses a combined operation: 0020 replaces `public.commit_access_observation`, whose original
body 0019's verifier pins. Preserve an intermediate merged commit whose newest migration is
0019, then add 0020 in a later merged commit. Plan the first operation against that earlier
0019 commit; the planner accepts it after main adds 0020 only while its planned bytes remain
identical. Listing 0019 alone against a commit already containing 0020 is refused as an
incomplete pending tail. Each operation uses the matching single read-only verifier and private
pre/post invariant under `scripts/backend/deploy/verify/`. These gates check migration history,
exact columns/defaults/check expressions/foreign keys, RLS, every table/column/routine grantee,
writer role reachability, SECURITY DEFINER/search path, and reviewed routine body hashes. The
0020 pins include the consolidated server correction and its token-fenced removal-only RPC.
Existing row counts and protected/free/settings row fingerprints must remain unchanged; 0020
also fingerprints every existing scoped ledger field, excluding only the newly added source
column. The accepted runner keeps these comparisons private. Live concurrent account or settings
changes may require the owner's private comparison after a verified apply.

The security rehearsal applies each migration through the actual pinned CLI as the ordinary
`postgres` role, on both upgrade and clean paths. It checks the pre-apply failure, preserves
nonempty old rows, and rolls back intentional routine body/ACL/search-path/definer, table/column
ACL, RLS/policy, shape and weakened-check drift. The existing 0019 behavioral ledger probe runs
at exactly 0019; the Apple ledger and removal probes run at 0020. All database execution remains
restricted to an ephemeral GitHub-hosted Linux runner.

The same workflow then runs `rehearse-access.sh` with the actual CLI, gateway and GoTrue. Its
first pass uses the exact deployed source, nearest import maps and frozen lock: anonymous local
verification reaches its handler, account endpoints reject missing/forged JWTs, valid Auth reaches
their request grammar, and missing Apple configuration grants nothing. Its second pass copies
the project into a disposable tree and replaces only Apple and RevenueCat provider module ports.
Actual entrypoints, handlers, Auth confirmation, rate limiter, PostgreSQL ledger and Ed25519
issuer remain unchanged. It verifies local and account proof signatures, explicit linking,
account conflicts, refusal without source authority, dual-auth transfer, former-owner removals,
and accountless Restore after transfer. Fresh ephemeral signing material distinguishes the new
worker; private fixture files and raw runtime logs are removed on exit. Mounted source/config/lock
bytes are compared after each served pass. This proves composition and envelope contracts with
synthetic provider I/O; it does not prove Apple certificates, OCSP, current provider API responses,
production configuration or deployment.

`node --test scripts/backend/access-runtime.test.mjs` exercises actual cold Deno graphs for all
three entrypoints, exact frozen npm closure and raw-specifier aliases, with source/alias/lock
negative controls. It also checks the generated provider fixture's actual graph and types while
retaining entrypoint/auth/store/issuer bytes. SQL and actual CLI serve tests skipped on this Mac
are not runtime evidence. Hosted rehearsal, provider configuration, protected deployment approval
and actual store/device QA remain distinct gates.

## QA sandbox sales switch and test accounts (owner-approved operations)

Two more operations prepare the QA sandbox lane. Each runs its SQL as one transaction, so a refusal
writes nothing, and each is chosen with the workflow input `policy_mode`:

- `qa-sandbox-sales-policy` (`off` / `on`, plus `policy_expected_revision`): publishes the pinned
  sandbox sales body as the next sandbox revision, compare-and-set on the approved expected revision
  under `apply_product_policy`'s advisory lock. The SQL names only the `sandbox` environment; the
  ledger row records the fixed all-zero operator id, never an owner identity. The first `on` also
  writes the sandbox paid cutoff (write-once), and only when none exists. Both bodies list the
  current QA test set's build ids (`QA_SANDBOX_SALES_BUILDS` in `operations.mjs`: the extension
  manifest version and the Apple CFBundleShortVersionString); a new test set changes them in one
  reviewed change. An operation that lists `provisional` content cannot be applied.
- `qa-sandbox-subjects` (`enable` with `subjects_sha256`, or `disable`): `enable` makes the enabled
  memberships exactly the accounts in the `QA_SANDBOX_SUBJECT_EMAILS_JSON` environment secret,
  `{"salt":"<32+ random hex>","emails":[...]}` (salt from `openssl rand -hex 32`; emails only from
  the designated QA accounts file). `subjects_sha256` is `<count>:<SHA-256>` of the salted
  canonical object; `node scripts/backend/deploy/deploy.mjs subjects-digest < secret.json` prints
  it without echoing the list, and the plan shows the count. Only per-email SHA-256 values reach
  the database. Unknown, ambiguous or unconfirmed accounts refuse the whole run; every other
  enabled membership is switched off (never deleted); rows are locked in the wrappers' order.
  `disable` switches every membership off and never deletes a row. Neither revokes sandbox rights
  already granted; `pause-qa-sandbox` stops every paid QA function at once. Once production has a
  paid cutoff, the sandbox sales switches refuse (`production_cutoff_present`); use
  `pause-qa-sandbox` then.

Their rehearsals prove negative controls write nothing, production rows and cutoffs stay untouched,
revisions are only appended, the policy reader serves exactly the approved body, and disable keeps
every row; `supabase/tests/qa_sandbox_subjects_operation_test.ts` races disable against in-flight QA
grants on the real wrappers.

### QA sandbox secrets (owner-approved operation)

`qa-sandbox-secrets` runs the secrets module (`deploy/qa-secrets.mjs`) through the same protected
workflow (`deploy/qa-secrets-operation.mjs` binds the commit on main, the tooling, the plan digest
and freshness). The workflow `mode` is the module's mode: `plan-only` (no secret is read), `apply`,
`rotate` or `disable`; `rotate` and `disable` are refused for every other operation. Only the apply
step of this operation receives `SUPABASE_QA_SECRETS_ACCESS_TOKEN` and the 19 `QA_STAGE_*` values.
The plan job rehearses the module unchanged on its throwaway database: its psql calls are pointed at
that database with the exact role names, so the generated SCRAM passwords really sign in (and a
wrong one is refused), and its Management API and GitHub reads are answered in memory. The
rehearsal proves the negative controls write nothing, apply writes exactly the required names with
matching digests and repeats as a no-change, an emergency pause wins over apply, rotate replaces
every password, and disable removes only the QA-prefixed names.
