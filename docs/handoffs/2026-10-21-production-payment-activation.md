---
title: "Production payment activation checkpoint"
status: active
created: 2026-10-21T17:35:00-07:00
updated: 2026-10-21T18:55:00-07:00
source: codex-personal
intended_receiver: production backend session and build owner
---

# Production payment activation checkpoint

## Current operational state

Foundation [PR522](https://github.com/ZackC-1/still-app/pull/522) merged at
`bac1539f382798fa2ca812dd782beabc76c47b69` after 32 checks. Deployment preservation fix
[PR525](https://github.com/ZackC-1/still-app/pull/525) merged at
`bc728bcabad9ef383906571206becd3f46b1377f` after all 30 checks passed. The latter is the pinned
backend deployment revision.

[Plan39707517059](https://github.com/ZackC-1/still-app/actions/runs/39707517059) passed for exactly
0025, 0026 and 0027. Its disposable receipt verified history 24→27, clean structural checks and
unchanged existing data snapshots. Matching
[apply39707838333](https://github.com/ZackC-1/still-app/actions/runs/39707838333) has passed its plan
and is waiting for the owner's `supabase-production` approval. The owner has been asked to use
Review deployments → supabase-production → Approve and deploy. No hosted migration write has
occurred at this checkpoint. Re-read the run before acting.

Sales remain off. The separate production Stripe webhook is created and disabled. Twenty production
configuration values are staged in GitHub's protected environment, not yet applied to Supabase.
The existing RevenueCat webhook URL, token and portal filters remain unchanged.

## Repository and concurrent ownership

The main checkout belongs to the separate visual/build session and was not edited here.

| Worktree | Branch / source | Responsibility |
|---|---|---|
| `/private/tmp/still-production-activation-20261021` | `codex/production-activation-ops-20261021`, source `a85491bc` now merged through PR525 | Protected deployment commands and evidence |
| `/private/tmp/still-production-readiness-docs-20261021` | `codex/production-readiness-docs-20261021`, PR527, prior checkpoint `40fa02ae` | Current runbook, original PR515 ancestry and this handoff |
| `/private/tmp/still-apple-production-public-config-20261021` | `codex/apple-production-public-config-20261021`, PR524 | Preserves PR520 and PR517 ancestry; public native configuration and trust packaging |
| `/private/tmp/still-canonical-analytics-20261021` | `codex/canonical-analytics-20261021`, PR526 | Web canonical analytics and integration tooling |
| `/private/tmp/still-apple-canonical-analytics-20261021` | Read current Git; reviewed source includes `0aeb70fc` and `d950d179` | Apple provenance and canonical analytics follow-on |

Final combined integration [PR528](https://github.com/ZackC-1/still-app/pull/528) is open; it preserves the public build/declaration and web/Apple analytics source. Required final-tree CI, disposable PostgreSQL CI checks and production deployment remain pending until their actual receipts pass. The owner approval for the foundation migration apply remains the next hosted checkpoint at this writing.

Source work is still active in agent-owned worktrees. Read Git status and coordinate before edits;
never discard another agent's dirty files. This checkpoint itself is a documentation edit in PR527.
Final integration may combine reviewed source ancestry to avoid repeated strict-base CI; no source
PR may merge without required final-tree checks. Keep docs527 until that integration to avoid base churn.

## Scope and decisions

Production must match the app's tested payment and sync behavior with separate live bindings.
Supabase holds payment/entitlement records; PostHog holds consented usage and conversion events.
Never copy sandbox customer purchases, account rights or credentials into production.

The owner authorized autonomous implementation and parallel agents, selected Stripe Managed Payments,
approved the four-benefit `still-free-v2` cutoff, and approved isolated device-only Apple review
sandbox access behind a separate switch. The four free protections and optional free sync remain
free. Review access cannot create live account rights or revenue. Review-proof issuance alone does
not enable purchase admission; final production-bound review testing also needs the reviewed sales
policy and exact build admission.

The RevenueCat server handler extension is authorized; its existing dashboard settings are preserved.
Planned versions are Chrome/Firefox 3.0.0 and Apple 3.0, subject to final QA. Final package inspection
still controls actual build admission. No synthetic live charge/refund should be manufactured.

## Verified engineering and provider preparation

- Foundation implements production Managed Payments checkout, GET-only recovery, narrow production
  ledger 0026, isolated review ledger 0027, canonical RevenueCat rights refresh, historical SKU
  compatibility, sales on/off and the four-free-benefit cutoff. Full local Deno passed 632 tests
  and 147 steps, one gated integration ignored; all 32 foundation CI checks passed.
- The first protected plan refused safely because 0026/27 invariant SQL emitted structural arrays.
  PR525 restores complete-row preservation objects without weakening the parser. 76 deployment
  tests, independent review, real PostgreSQL preservation tests and all browser lanes pass.
- Live provider account/catalog read-backs matched the intended separate V3 USD 9.99 one-time price,
  product, RevenueCat production app, entitlement and offering. Historical products remain separate.
  Apple key format and runtime composition passed; an API parameter-validation response is not
  proof of an actual purchase.
- Return pages are published via merged PR523 on gh-pages. Success/cancel paths and .html variants
  return HTTP 200 and match source bytes. No tracking scripts were added.
- PR524 fixes native public Supabase configuration and trust packaging. Initial CI caught a synthetic
  trust fixture placed inside the handwritten browser fixture directory. It is moved to the release
  tooling fixture directory while retaining the browser guard. PR517's declaration guard is being
  integrated with trust checks; current paid flags are not flipped. Final CI remains required.
- Web canonical analytics SQL 0028, consent fences and actual Chrome/Firefox factory coverage pass
  focused tests and independent review. CI found closed deployment capability/manifest integration
  gaps; their exact allowlists are corrected and final CI remains required.
- Apple optional analytics uses actual purchase provenance and canonical server-authored descriptors
  through a dedicated consent-fenced client lane. Generic queues still reject purchase events.
  The reviewed lock-order fix has a two-session SQL regression. Full iPhone simulator compilation
  passed, and arm64 Mac Debug compilation also passed. Both used signing disabled. Integrated disposable PostgreSQL CI, protected deployment rehearsals and signed final packages remain separate pending gates.
- Apple optional attribution expires after 90 days; event delivery rejects events older than 30 days.
  Late or ambiguous refunds can be omitted. These are consented conversion subsets, not accounting.

## Analytics and private material

The session dashboard is [Still Pro Conversion Readiness](https://us.posthog.com/project/624923/dashboard/2242729).
It has three interaction charts and canonical sale/refund counts by surface. All saved aggregate
queries execute; test/dev and internal filters are set. Empty charts are labelled activation pending,
not evidence of failure. Missing release-channel markers are not treated as verified release traffic.
The existing legacy dashboard is untouched. No final-package delivery or erasure acceptance is claimed.

Historical hosted analytics secrets/functions applies were verified. No schedule/switch activation
was found in retained runs. Use the protected gates to establish current state: deploy selected
functions, enable existing erasure schedule, wait for an actual successful run, verify project/deletion
permissions, then enable subjects. A dummy permission probe is not completed account erasure.

Secrets remain outside Git and chat. The public-only build trust handoff is
`/Users/zack/.local/share/still/production-payments-20261021/public-access-keys.json`.
Match it against hosted signer readback before packaging. Private prepared configuration and encrypted
read-only reports are in the existing owner-local locations recorded by the operational tooling;
do not print their contents. Mem0 retrieval quota and the claude-mem observer are exhausted;
repository evidence and the work-state list remain the active durable record.

## Next actions and blockers

1. Wait for the owner approval of apply39707838333; inspect the closing receipt before any next
   production operation. One global workflow concurrency group means operations are sequential.
2. If PR528 merges before route deployment, apply 0028/0029 through a separate exact plan at its final merged SHA after the already-planned foundation apply; do not add migrations to that existing approval. Then plan/apply reviewed purchase secrets, the fixed nine purchase routes and separately sync-settings from the final selected SHA. Its route gate requires every migration at that SHA, avoiding duplicate intermediate deployments. Each apply needs its own owner approval. Never bypass protection
   with direct Supabase CLI/SQL or self-approval. Handle partial/unknown outcomes before retrying.
3. Verify hosted source/configuration and negative routes; keep the new Stripe endpoint disabled
   until its hosted handler/signature verification is ready. Preserve existing RevenueCat settings.
4. Finish independent review, native compilation, SQL/deployment rehearsals and required final-tree CI
   for the canonical analytics and packaging integration. Apply 0028/0029 only through later exact
   migration plans; do not add them to the already-approved 0025–27 scope.
5. Complete protected analytics activation and prove consent, identity, production event delivery and
   erasure with designated final-package checks. Genuine production customer fulfilment/refunds remain
   explicitly unverified until observed. PROD-02 is still a proposal, not an executable check.
6. Owner and Claude Code finish final screens/images on the morning of October 22, 2026. Final signed
   artifacts, release values, store declarations, device acceptance and sales activation follow.
7. After backend and visuals, perform the requested deep unused-code/test audit. Prove obsolescence
   before removal, fix bugs rather than hiding failures, preserve meaningful coverage, and recheck
   affected artifacts. Do not claim size/performance improvements without measurements.

Use the [activation plan](../plans/2026-10-21-002-production-activation-and-verification.md),
[closed deployment procedure](../release/purchase-routes-and-secrets.md) and updated
[go-live runbook](../release/v3-go-live-runbook.md). Do not equate code merge, hosted deployment,
store approval, public availability and customer-delivery proof.
