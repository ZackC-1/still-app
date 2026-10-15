# QA runtime reliability verification

Source base: d984146c. Branch: fix/qa-runtime-diagnostics-20261014.

## Reproduction and focused checks

- Before the writer fix, six concurrent driver requests opened six sockets and the new regression failed (expected one). Afterward, all six completed on one socket; idle release and reconnection passed in 20 seconds. The loopback fixture uses the real Postgres.js client and no database or real credential. SQL semantics remain a separate disposable-CI gate.
- Before the content fix, four new lifecycle cases failed: three authority reads during 125 seconds initially Off, a stale paid effect on resume, and inability to start a fresh read while an old response remained pending. The expanded content session suite now covers eleven cases, including independently protected access and extras with Shorts Off.
- Focused content, Safari mobile, entitlement-consumer and signed-out suites: 53 tests passed. The separate autoplay integration suite passed with the earlier focused group (70 total at that point).
- Full Deno functions: 582 passed, 143 steps, one existing ignored test.
- Full pnpm test passed, including the real Swift compiler tests. The initial restricted-shell run could not write the macOS module cache; the authorized normal-environment rerun passed.
- Lint, typecheck and all browser/webview builds passed. Browser fixtures: 350 passed, 25 skipped (5.1 minutes).
- Backend deployment/plan guards: 160 passed, four skipped and one cold-cache test initially blocked by sandbox DNS. The network-enabled plan-suite rerun passed all 15 tests, including that test.

## Review

Simplification used the ce-simplify-code reuse, quality and efficiency rubrics inline, per repository mapping. No behavior-preserving simplification was justified. The watch option is deliberately content-only: applying it to all consumers caused an unwanted signed-out popup transition, which existing tests detected and the final diff avoids.

Code review: skipped (ce-code-review unavailable). The skill's full independent dispatch/finish pipeline cannot produce an independent receipt under this session's repository instruction to run agent tasks in the main thread. No peer was launched. A manual final diff review covered correctness, project rules, security, reliability, performance, testing and lifecycle races. No unresolved source defect was found. This is author review, not independent review.

The manual review traced late observations through epoch rejection and the flight-identity finalizer; checked that the content watch is cleared before its synchronous invalidation callback; checked free versus paid resume behavior; confirmed the pool factory retains prepare:false; and checked that settings transactions use the transaction handle. The wire fixture cannot prove SQL correctness: the added production-factory concurrent-read/rollback step runs in the existing disposable settings rehearsal. No production migration, role, endpoint, or payment setting changes are in this diff.

## Remaining gates

Hosted deployment and live peer checks remain pending. The bounded pool is a mitigation for observed capacity exhaustion; it does not identify every connection owner. A distinct paid-on candidate and its unchanged 30-minute stress gate remain required before claiming the original QA failures resolved. Frozen .357 artifacts are untouched.
