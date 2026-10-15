# Faster sandbox sync verification

Source branch: feat/sync-notifications-20261015, based on main 47d965e2.

## Implemented and locally checked

- Private QA Broadcast adapter and canonical refresh on initial join/change/rejoin. A delayed read retains one trailing refresh; old account lifetimes cannot refresh a new session.
- Additive migration0023: enabled-QA-member-only server hints, own-account receive policy, no client send policy, fixed payload with no settings or receipt. Best-effort notification does not confer authority.
- Existing five-second acquisition and outage backoff remain. No production realtime migration or ordinary function deployment.
- Sandbox build admission templates add2.1.1.361, preserving all prior entries. Hosted application remains a separate protected operation.
- Port tests observed red (missing subscription method) before implementation. Focused client suite85passed, then atomic suite69passed after adding delayed-upload scenario.
- Full repository tests passed: core5304+39skipped, Chromium768, Safari360, owner-admin58; final helper suite58+1skipped. Native Swift integration included. Initial sandboxed run could not access the Swift compiler cache; the permitted rerun passed.
- Lint, typecheck and standard build passed. Deploy-operation suites passed. Playwright fixtures: 350 passed, 25 skipped.
- Deno check of new database test passed. Actual database test runs in the existing disposable Supabase CI lane; no local Docker daemon is available. Hosted tests have not run.

## Review coverage

Inline review covered correctness, account isolation, migration safety, failure recovery and test fidelity under the repository's sequential Task mapping. Fixed a test false-pass risk by requiring the transaction's deliberate rollback sentinel, and strengthened the migration invariant to include every access-right field. Preserved legacy production subscription behavior and centralized the existing invalidation path rather than adding a second sync service.

Code review: skipped (ce-code-review unavailable). The attempted independent Claude review was rejected by automatic approval review before launch because external source transfer was not specifically authorized. The full independent review receipt is unavailable; the local manual diff scan is explicit, not an independent-review claim. No alternate external route was attempted.

## Pending gates

Real database trigger/RLS/WebSocket rehearsal, protected PR checks/merge, protected migration0023 and sandbox build admission, exact candidate builds/live latency and fallback tests, available Apple build tests, and physical-device owner QA. Main merge alone establishes none of the hosted/device gates.

The first disposable run confirmed the real policy expression and managed Realtime payload: Supabase adds a random message UUID beside schema=1. The test now asserts precisely those keys. Policy verification pins the exact expression and includes a widened-policy negative control. The existing analytics readiness gate recognizes only the authenticated membership predicate; an anonymous grant remains refused. The verifier also handles missing routines before apply. The next main first-parent sequence is 361 (360 is the earlier policy-only merge); candidate admission is 2.1.1.361.
