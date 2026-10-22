---
title: "Production payment activation checkpoint"
status: active
created: 2026-10-21T17:35:00-07:00
updated: 2026-10-21T19:54:00-07:00
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
[apply39707838333](https://github.com/ZackC-1/still-app/actions/runs/39707838333) completed successfully
on the pinned `bc728bcabad9ef383906571206becd3f46b1377f`: production history 24→27, all 18 structural
checks clean, all three preservation snapshots unchanged (verified at 02:07 UTC). This is a verified production migration
apply, not merely disposable CI evidence.

Post-apply [DB-01 run39709691391](https://github.com/ZackC-1/still-app/actions/runs/39709691391)
also completed successfully. Its encrypted report was decrypted privately with owner-only
permissions: newest migrations 0027, 0026, 0025; seven of seven QA subjects enabled; one sandbox
cutoff; narrow read-only transaction rolled back; no withheld values. `needs-review` is the expected
catalogue verdict, not a failed check. DB-01 confirms this tail and these counts; the apply receipt
supplies the separate structural/preservation proof.

[purchase-secrets apply39709986466](https://github.com/ZackC-1/still-app/actions/runs/39709986466)
completed after its matching plan39709662125 (verified at 02:16 UTC): 21 values installed, two
legacy RevenueCat values kept, three role URLs present but not managed by this operation, no issues.
This does not deploy functions or prove a runtime-signed purchase response.

[PROD-01 run39710042569](https://github.com/ZackC-1/still-app/actions/runs/39710042569) completed;
its privately decrypted report explicitly shows no production sales-policy row, expected revision
0, no admitted builds and no production cutoff. Sales/channel enabled fields and offers are null,
not literal false fields in an existing policy. The separate production Stripe webhook remains
disabled. The existing RevenueCat webhook URL, token and portal filters remain unchanged.

[sync-settings apply39711029849](https://github.com/ZackC-1/still-app/actions/runs/39711029849)
completed and verified at 02:26 UTC, with no issue or recovery. Its exact bundle from `bc728bca`
is identical to final integration `589341f1`. A subsequent unauthenticated production POST returned
401; no authenticated customer data was read or written by that check.

## Repository and concurrent ownership

The main checkout belongs to the separate visual/build session and was not edited here.

| Worktree | Branch / source | Responsibility |
|---|---|---|
| `/private/tmp/still-production-activation-20261021` | `codex/production-activation-ops-20261021`, source `a85491bc` now merged through PR525 | Protected deployment commands and evidence |
| `/private/tmp/still-production-readiness-docs-20261021` | `codex/production-readiness-docs-20261021`, PR527, prior checkpoint `40fa02ae` | Current runbook, original PR515 ancestry and this handoff |
| `/private/tmp/still-apple-production-public-config-20261021` | `codex/apple-production-public-config-20261021`, PR524 | Preserves PR520 and PR517 ancestry; public native configuration and trust packaging |
| `/private/tmp/still-canonical-analytics-20261021` | `codex/canonical-analytics-20261021`, PR526 | Web canonical analytics and integration tooling |
| `/private/tmp/still-apple-canonical-analytics-20261021` | Read current Git; reviewed source includes `0aeb70fc` and `d950d179` | Apple provenance and canonical analytics follow-on |
| `/private/tmp/still-apple-analytics-integration-20261021` | `codex/apple-analytics-integration-20261021`, PR528, `589341f1` | Final combined source and CI |
| `/private/tmp/still-production-access-trust-pin-20261021` | `codex/production-access-trust-pin-20261021`, PR530, `08a37fc2` | Reviewed public-only trust pin; not merged |
| `/private/tmp/still-v3-privacy-publication-20261021` | `codex/publish-v3-purchase-analytics-privacy-20261021`, PR529, `e115c097` | Approved conditional privacy publication; not published |

Final combined integration [PR528](https://github.com/ZackC-1/still-app/pull/528) merged at
`c24a246da9607a069337d1a80c0b4cc0224f10c5` at 02:54 UTC on October 22 (19:54 PT October 21).
Its source head was `589341f1`; main CI passed: Linux core 5,671 with 84 platform skips; Chromium 855; Safari 405;
webview 19; owner-admin 58; Node suites 58 with one skip and 137 passed; both builds passed.
Required main, Deno and Playwright checks passed: 30 successful checks. Browser fixture phases
passed 367 unconfigured (37 skips), 212 configured (192 conditional skips), and 96 paid-tier free-outcome
cases (one skip), with no failures or flaky cases. GitHub also marked component PR517/520/524/526 merged.
Disposable PostgreSQL CI is separate from
production verification. Foundation migrations, purchase secrets and sync-settings are verified in
production; the nine purchase routes and final analytics deployment remain pending.
The optional preview could not complete because dependency installation timed out twice; no
successful preview verification is claimed.

The integration, public-pin, privacy-publication and operations worktrees were clean when this
checkpoint was committed; this docs checkpoint contains only the three stated documentation files.
Re-read status before resuming. Source work is still active in agent-owned worktrees. Read Git status and coordinate before edits;
never discard another agent's dirty files. This checkpoint itself is a documentation edit in PR527.
PR527 remains open for the next model to integrate merged main and the reviewed public pin before
its own final checks and merge.

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
  tooling fixture directory while retaining the browser guard. PR528 includes PR517's declaration
  guard with trust checks; current paid flags are not flipped. Final CI remains required.
- Web canonical analytics SQL 0028, consent fences and actual Chrome/Firefox factory coverage pass
  focused tests and independent review. CI found closed deployment capability/manifest integration
  gaps; their exact allowlists are corrected and final CI remains required.
- Apple optional analytics uses actual purchase provenance and canonical server-authored descriptors
  through a dedicated consent-fenced client lane. Generic queues still reject purchase events.
  The reviewed lock-order fix has a two-session SQL regression. Full iPhone simulator compilation
  passed, and arm64 Mac Debug compilation also passed. Both used signing disabled. PR528 tracks disposable PostgreSQL CI and protected deployment rehearsal evidence; final signed packages and production delivery remain separate pending gates.
- Apple optional attribution expires after 90 days; event delivery rejects events older than 30 days.
  Late or ambiguous refunds can be omitted. These are consented conversion subsets, not accounting.

Draft privacy publication [PR529](https://github.com/ZackC-1/still-app/pull/529) is open and unpublished.
Publication is approved after PR527's combined source and checks complete. It carries the reconciled
PR477 purchase disclosures plus canonical analytics and V3 sharing wording, preserved from source
55f09c43. Source reconciliation, publication and App Privacy portal changes remain distinct;
confirm the policy date matches the eventual publication day.

Public trust pin [PR530](https://github.com/ZackC-1/still-app/pull/530), commit `08a37fc2`, matches
genuinely fetched hosted metadata on all three comparison checks and passed independent review.
PR530 is not merged. This establishes configuration agreement; no runtime-signed access proof or
final signed artifact has yet been verified.

## Analytics and private material

The session dashboard is [Still Pro Conversion Readiness](https://us.posthog.com/project/624923/dashboard/2242729).
It has three interaction charts and canonical sale/refund counts by surface. All saved aggregate
queries execute; test/dev and internal filters are set. Empty charts are labelled activation pending,
not evidence of failure. Missing release-channel markers are not treated as verified release traffic.
The existing legacy dashboard is untouched. No final-package delivery or erasure acceptance is claimed.

Historical hosted analytics secrets/functions applies were verified. No schedule/switch activation
was found in retained runs. Fresh read-only hosted metadata confirms `ANALYTICS_SUBJECTS_ENABLED`
is absent; no value or secret digest was printed and no analytics switch was activated.

Owner screenshots confirm the active PostHog account-deletion key has **person: write** and
**project: read**, restricted to the intended Still project. The 19:37 PT Supabase screenshot
confirms exposed schemas are exactly `public` and `graphql_public`; `private` and `still_qa_checks`
are unchecked and `net` is absent. Discard client IP data was confirmed earlier. These resolve the
owner configuration questions, but do not replace the hosted provider proof.

Use the protected gates to establish current state: deploy selected functions, enable the existing
erasure schedule, wait for an actual successful run, verify project/deletion permissions through
the runtime, then enable subjects. A dummy permission probe is not completed account erasure.

Secrets remain outside Git and chat. The public-only build trust handoff is
`/Users/zack/.local/share/still/production-payments-20261021/public-access-keys.json`.
Its hosted metadata comparison passed as recorded above; retain that evidence and verify the final packaged binding. Private prepared configuration and encrypted
read-only reports are in the existing owner-local locations recorded by the operational tooling;
do not print their contents. Mem0 retrieval quota and the claude-mem observer are exhausted;
repository evidence and the work-state list remain the active durable record.

## Next actions and blockers

1. Honor the owner's requested switch to **GPT-6.1 Sol** now that PR528 passed required checks
   and merged, and this durable handoff is committed. Do not start another protected deployment
   before that switch. Foundation migrations, purchase secrets, sync-settings, DB-01
   and PROD-01 are complete as recorded above.
2. The next model should merge PR528's final main commit and reviewed PR530 `08a37fc2` into PR527
   with ancestry preserved, retaining combined privacy source `55f09c43` exactly. Run final checks
   once on that combined tree, merge PR527, and close PR530 as incorporated. Then publish approved
   PR529 after checking source equality and publication date. Neither final main nor the public pin
   was integrated into PR527 during this checkpoint; privacy publication was also deferred.
3. After the model switch and reviewed source integration, apply 0028/0029 through a separate exact plan at its final merged SHA; do not
   replay or expand the completed foundation scope. Deploy the fixed nine purchase routes from the
   final selected SHA, whose gate requires every migration at that SHA. Handle sync-settings through
   its separate operation and verify whether its source changed before planning any further deploy.
   Each apply needs its own owner approval. Never bypass protection
   with direct Supabase CLI/SQL or self-approval. Handle partial/unknown outcomes before retrying.
4. Verify hosted source/configuration and negative routes; keep the new Stripe endpoint disabled
   until its hosted handler/signature verification is ready. Preserve existing RevenueCat settings.
5. Retain completed native compilation and disposable SQL/deployment evidence. Apply 0028/0029
   only through new exact migration plans; do not replay the completed 0025–27 scope.
6. Complete protected analytics activation and prove consent, identity, production event delivery and
   erasure with designated final-package checks. Genuine production customer fulfilment/refunds remain
   explicitly unverified until observed. PROD-02 is still a proposal, not an executable check.
7. Owner and Claude Code finish final screens/images on the morning of October 22, 2026. Final signed
   artifacts, release values, store declarations, device acceptance and sales activation follow.
8. After backend and visuals, perform the requested deep unused-code/test audit. Prove obsolescence
   before removal, fix bugs rather than hiding failures, preserve meaningful coverage, and recheck
   affected artifacts. Do not claim size/performance improvements without measurements.

Use the [activation plan](../plans/2026-10-21-002-production-activation-and-verification.md),
[closed deployment procedure](../release/purchase-routes-and-secrets.md) and updated
[go-live runbook](../release/v3-go-live-runbook.md). Do not equate code merge, hosted deployment,
store approval, public availability and customer-delivery proof.
