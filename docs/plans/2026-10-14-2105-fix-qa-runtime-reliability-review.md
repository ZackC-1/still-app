# QA runtime reliability plan review

Reviewed 2026-10-14, non-interactive, in the main thread per repository agent mapping. This is an inline review, not an independent review.

Plan: `2026-10-14-2105-fix-qa-runtime-reliability-plan.md`.

Coverage: coherence, feasibility, scope, security and adversarial lenses. No configured Compound Packs. No cross-model review.

- Coherence: R1–R4 map to U1–U3; eventual delivery is explicitly distinguished from recovery.
- Feasibility: existing watch cleanup already guards the refresh finalizer with accessWatching. The implementation must invalidate old paid snapshots on resumption; merely stopping timers is insufficient. Existing transactions use their transaction handle rather than recursively acquire the outer pool. Driver behavior can be tested with a local credential-free protocol fixture; full SQL semantics remain covered by the disposable CI rehearsal.
- Security: preserve rate-limiter failure, narrow roles and account epochs. Missed account invalidation while Off is covered by fresh-observation-before-paid-effects. No new endpoint or data collection is introduced.
- Adversarial: exhausted capacity does not identify the owner of the connections. KTD1 remains a mitigation requiring hosted confirmation; server limits and connection termination are excluded.
- Scope: reuse current cache lifecycle and writer factory. No new retry framework, provider or schema.

No unresolved implementation-blocking finding. Hosted rollout still requires the existing protected deployment approval and live verification.
