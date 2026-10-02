# Backend security rehearsal

This is the credential-free U1 inventory/assertion/rehearsal slice. Production apply is unavailable.
No numbered migration is assigned from the local 0001–0013 inventory. The unnumbered SQL candidates
change privilege reachability in synthetic CI; they do not add a settings schema or change rights.

Run `node --test scripts/backend/plan.test.mjs` for immutable source/target/scope checks. The actual
SQL test requires the new `Supabase security rehearsal` GitHub job. `rehearse.sh` refuses the owner
Mac. It creates a disposable cloud Supabase runtime, applies the real migrations, checks upgrade
preservation/free sync/server JWT and webhook paths, injects unsafe grants **after** hardening and
requires final assertions to fail, then destroys its data. Cleanup also runs on job failure. No
production secrets or customer data enter this job, its plan or its logs. A failed/skipped cloud
test is not evidence that SQL safety passed. Synthetic RevenueCat responses do not certify a provider.

Before a production candidate can be assigned or a protected apply job built:

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
4. Verify the public GitHub production environment exists with the owner as required reviewer,
   prevention of self-review, no admin bypass and main-only trusted deployment branches. Verify
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
