---
title: Match Supabase security rehearsals to managed owners and role authority
category: security-issues
track: bug
problem_type: integration_error
module: scripts/backend
applies_when: Rehearsing catalog hardening and provider event-trigger preservation on disposable Supabase infrastructure
date: 2026-10-03
status: active
tags:
  - supabase
  - supautils
  - default-privileges
  - transactions
  - security-rehearsal
---

Local handler tests and SQL parsing can pass while a security rehearsal fails on the actual Supabase runtime. Managed event-trigger ownership, creator authority, and connection authentication require hosted behavioral proof.

The catalog rehearsal exposed four distinct causes:

- Supautils rejected a superuser-owned event trigger calling a function not owned by a superuser. The synthetic fixture needed a compatible declared function owner.
- A malformed audit predicate prevented function installation. A minimal grammar correction preserved both provider-drift predicates and all 18 audit violation branches. Parsing catches this syntax failure, but cannot establish managed runtime behavior.
- After installation, the provider body matched its reviewed literal while the binding owner was managed `supabase_admin`, not the owner initially expected by the fixture. The ordinary nonsuperuser `postgres` role also lacked inherited or SET authority over that selected creator.
- The Deno role connection worked over TCP, but later `psql` setup defaulted to a peer-authenticated Unix socket. The fixture connection needed explicit loopback TCP and the same disposable credential. A direct-trigger denial assertion also needed the actual runtime error wording.

The correction keeps the full provider descriptor literal: owner, return type, language, configuration, definer flag, body and binding metadata remain explicit. Use the observed managed owner in the synthetic descriptor; do not learn an approval baseline automatically from whatever the current database returns.

Use the already declared disposable fixture administrator for privileged synthetic hardening. Keep ordinary client, sync and application probes on their original roles. Before privileged apply, prove that the ordinary role fails with SQLSTATE 42501 at the expected creator-default boundary, then compare catalog, ACL and membership state after rollback. The test makes observable writes and grants inside the transaction before provoking the failure; a rejected request alone would not prove rollback.

Apply hardening and its assertions in one transaction. For concatenated SQL sent to `psql`, use ON_ERROR_STOP, --single-transaction and --file=-. A failed baseline must stop before hardening. Declare the privileged synthetic role explicitly rather than elevating `postgres` or adding broad managed-role membership. Production execution authority still needs separate exact-target evidence and protected owner approval.

Verification at reviewed source `2f93ea137aad234035daa493510069ad44791edc` is recorded by [PR229](https://github.com/ZackC-1/still-app/pull/229) and [hosted rehearsal 37090313575](https://github.com/ZackC-1/still-app/actions/runs/37090313575):

- 8 Node plan/entrypoint tests; 2 audit tests and one disposable TLS test.
- 2 real SQL integration tests and 14 steps, including all 16 provider-descriptor drift negatives, ordinary-role denial/full rollback, privileged preservation, creator/policy/client denials, free own-account sync, historical rights and real handler claim/release/retry.
- 33 pgTAP assertions against reinstalled hardened state, plus 54 handler/JWT/auth tests.
- Final plan verification and EXIT cleanup completed; the workflow cleanup reported the Supabase setup stopped. Container/volume absence and cancellation cleanup were not independently read back, so this evidence does not establish either.

The passing run used Deno 2.8.3 and Supabase CLI 2.119.0 and took 2m04s. These are verification versions, not a claim that future managed runtimes retain identical metadata or error text. Recharacterize changed runtime behavior with a disposable hosted fixture while preserving the security predicates.

Relevant sources are the [fixture](../../../scripts/backend/sql/synthetic-catalog-fixture.sql), [hardening](../../../scripts/backend/sql/hardening-candidate.sql), [audit](../../../scripts/backend/sql/security-audit-candidate.sql), [role and rollback probes](../../../supabase/tests/catalog_preconditions.ts), [integration harness](../../../supabase/tests/security_foundation_test.ts), [runner](../../../scripts/backend/rehearse.sh), and [operational boundaries](../../../scripts/backend/README.md). This proves the explicitly privileged synthetic rehearsal; it does not prove a production execution role, live provider preservation, deployment approval, or lossless migration reversal.
