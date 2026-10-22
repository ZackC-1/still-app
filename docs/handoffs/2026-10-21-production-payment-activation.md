---
title: "Production payment activation checkpoint"
status: active
created: 2026-10-21T17:35:00-07:00
updated: 2026-10-21T22:46:00-07:00
source: codex-personal
intended_receiver: production backend session and build owner
---

# Production payment activation checkpoint

## Current operational state

Foundation [PR522](https://github.com/ZackC-1/still-app/pull/522) merged at
`bac1539f382798fa2ca812dd782beabc76c47b69` after 32 checks. Deployment preservation fix
[PR525](https://github.com/ZackC-1/still-app/pull/525) merged at
`bc728bcabad9ef383906571206becd3f46b1377f` after all 30 checks passed. That revision remains the
verified foundation deployment revision. The current rollout source is merged main
`26bf5a947de9fef70102c9be87f1e69806cbce46`; existing deployment receipts retain their original pins.

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
not literal false fields in an existing policy. The separate production Stripe webhook was disabled
at that baseline and has since been enabled after the repair proof recorded below. The existing
RevenueCat webhook URL, token and portal filters remain unchanged.

[sync-settings apply39711029849](https://github.com/ZackC-1/still-app/actions/runs/39711029849)
completed and verified at 02:26 UTC, with no issue or recovery. Its exact bundle from `bc728bca`
is identical to final integration `589341f1`. A subsequent unauthenticated production POST returned
401; no authenticated customer data was read or written by that check.

Exact [migration plan39718015533](https://github.com/ZackC-1/still-app/actions/runs/39718015533)
passed at `2bad3028d8b9d8c6fd403c8ae5fd2327534ec4f3` for only 0028 and 0029. The downloaded
plan and disposable replay receipt match digest
`264438fba4729a8e962e3ab73d9c37fac92508d5dbacf87287b9152cf033cb9b`: history 27→29,
all 14 checks clean, both preservation snapshots unchanged, no issues or warnings. Private evidence
is under `/tmp/still-rollout-39718015533/`.

Matching [apply39718256847](https://github.com/ZackC-1/still-app/actions/runs/39718256847) completed
after the owner's personal approval, with the actual production receipt verified at 03:47:24 UTC
October 22 (20:47:24 PDT October 21). It confirms exact source `2bad3028` and the digest above,
production history 27→29, all 14 checks clean, both preservation snapshots unchanged, no issues or
warnings and no recovery needed. The closing receipt at
`/tmp/still-rollout-39718015533/production-receipt.json` explicitly targets `production`; the earlier
envelope in the log is disposable replay evidence and must not be substituted for it.

Fresh [DB-01 run39718854455](https://github.com/ZackC-1/still-app/actions/runs/39718854455)
succeeded. Its privately decrypted report confirms hosted tail 0029/0028/0027, a narrow read-only
transaction and rollback proof, and nothing withheld. `needs-review` remains the expected catalogue
verdict. Private evidence is under `/tmp/still-db01-39718854455/`; no identity details were output.

The exact nine-route [purchase-functions plan39718857548](https://github.com/ZackC-1/still-app/actions/runs/39718857548)
passed at `2bad3028`, with digest
`8f7ccf06e1a627a7c73fa85e68ca8ced2d17d59c4a5d81f9ce7902f682b51f9f`. It pins all nine routes,
JWT settings, fixed deployment order and all 29 migration prerequisites. All eight rehearsal proofs
passed, including negative cases, source read-back, repeat application and settings-sync isolation.
Private evidence is under `/tmp/still-purchase-functions-39718857548/`.

Matching [purchase-functions apply39719229501](https://github.com/ZackC-1/still-app/actions/runs/39719229501)
completed after the owner's approval. Its actual closing record verifies five routes created and
four deployed, with source and JWT read-back for all nine, no issues and no recovery needed.
Settings sync was untouched. The downloaded plans match in source, bundles, JWT settings and
prerequisites. Their only differences are mode and its bound digest: the apply digest is
`75b14af991dd1c0844555d724ac4068ab3d4b1279e5f3f4755709e93ea7ee0b5`.
Private closing record: `/tmp/still-purchase-functions-39718857548/production-closing-record.md`.
Settings sync is already deployed and its source has not changed; no repeated deployment is planned.

Initial probes passed eleven of thirteen cases. The Stripe webhook returned 503 for unsigned and
invalid-signature POSTs, where 400 was expected; GET correctly returned 405. Read-only diagnosis
confirmed that hosted configuration matches the existing local writer configuration and all 21
prepared payment values, but the new strict parser rejects the valid pooler username form containing
the role and project suffix. Boolean-only evidence is in
`/tmp/still-purchase-functions-39718857548/runtime-config-readonly-proof.json`. No SQL or provider
write was used for that configuration diagnosis.

Narrow parser repair [PR531](https://github.com/ZackC-1/still-app/pull/531), head
`55e12172de053139a8ac9b02a1f33d464d3b7089`, merged as
`26bf5a947de9fef70102c9be87f1e69806cbce46` at 05:07:50 UTC October 22. Its isolated worktree is
`/private/tmp/still-production-writer-pooler-fix-20261021`. It includes security regression tests and
plan 006. Seventeen focused tests, 651 Deno tests/147 steps (one gated test ignored), lint and checks
passed; independent final-head review found no blockers. Actual private writer configuration and
all 21 prepared values compose the full runtime with zero SQL. [CI39723705611](https://github.com/ZackC-1/still-app/actions/runs/39723705611)
passed all 12 checks. Only the `create-web-checkout`, `complete-web-checkout` and `stripe-webhook` upload bundles
changed; the other six purchase bundles and all five analytics bundles were unchanged. The separately
approved repair deployment completed as recorded below.
New exact-revision [settings/GoTrue rehearsal39726287757](https://github.com/ZackC-1/still-app/actions/runs/39726287757)
passed on `26bf5a947de9fef70102c9be87f1e69806cbce46` using disposable infrastructure. This
establishes the rehearsal prerequisite at the repair pin, not hosted repair or final-device acceptance.

The pre-enablement read-only Stripe inventory confirmed live mode, disabled status, intended URL,
pinned API version and exact five-event set. The later conditional enablement proof below supersedes
that disabled status; the original 503 blocker is resolved by the deployed repair and passing probes.
Exact-revision [settings/GoTrue rehearsal39717958292](https://github.com/ZackC-1/still-app/actions/runs/39717958292)
passed on the pinned revision using disposable infrastructure. It does not establish hosted
deployment or final-device acceptance.

## Repository and concurrent ownership

The main checkout belongs to the separate visual/build session and was not edited here.

| Worktree | Branch / source | Responsibility |
|---|---|---|
| `/private/tmp/still-production-activation-20261021` | `codex/production-activation-ops-20261021`, incorporates main `26bf5a94` and existing checkpoint commits | Protected deployment commands and evidence; current checkpoint |
| `/private/tmp/still-production-readiness-docs-20261021` | `codex/production-readiness-docs-20261021`, PR527 head `8c425aaa`, merged `2bad3028` | Runbook, PR515/477 ancestry, merged main and reviewed PR530 public pin |
| `/private/tmp/still-apple-production-public-config-20261021` | `codex/apple-production-public-config-20261021`, PR524 | Preserves PR520 and PR517 ancestry; public native configuration and trust packaging |
| `/private/tmp/still-canonical-analytics-20261021` | `codex/canonical-analytics-20261021`, PR526 | Web canonical analytics and integration tooling |
| `/private/tmp/still-apple-canonical-analytics-20261021` | Read current Git; reviewed source includes `0aeb70fc` and `d950d179` | Apple provenance and canonical analytics follow-on |
| `/private/tmp/still-apple-analytics-integration-20261021` | `codex/apple-analytics-integration-20261021`, PR528, `589341f1` | Final combined source and CI |
| `/private/tmp/still-production-access-trust-pin-20261021` | `codex/production-access-trust-pin-20261021`, PR530, `08a37fc2` | Reviewed public-only trust pin; merged through PR527 |
| `/private/tmp/still-v3-privacy-publication-20261021` | `codex/publish-v3-purchase-analytics-privacy-20261021`, PR529, merged `e8a34d81` | Approved privacy publication; both live paths verified |

Final combined integration [PR528](https://github.com/ZackC-1/still-app/pull/528) merged at
`c24a246da9607a069337d1a80c0b4cc0224f10c5` at 02:54 UTC on October 22 (19:54 PT October 21).
Its source head was `589341f1`; main CI passed: Linux core 5,671 with 84 platform skips; Chromium 855; Safari 405;
webview 19; owner-admin 58; Node suites 58 with one skip and 137 passed; both builds passed.
Required main, Deno and Playwright checks passed: 30 successful checks. Browser fixture phases
passed 367 unconfigured (37 skips), 212 configured (192 conditional skips), and 96 paid-tier free-outcome
cases (one skip), with no failures or flaky cases. GitHub also marked component PR517/520/524/526 merged.
Disposable PostgreSQL CI is separate from
production verification. Migrations through 0029, purchase secrets and sync-settings are verified in
production, including source/JWT read-back for all nine purchase routes and all five analytics
routes. The erasure schedule is installed and the Stripe runtime repair is deployed; an actual
successful worker run, final client acceptance and subjects switch remain pending.
The optional preview could not complete because dependency installation timed out twice; no
successful preview verification is claimed.

The owner authorized resuming this checkpoint. The PR527 worktree was clean at `fb0922ed` before
consolidation. Merge `fb4ca36a` incorporates main `c24a246d`; merge `f7cf38c9` incorporates reviewed
PR530 `08a37fc2`, preserving both ancestries. The privacy conflict retained source `55f09c43`
byte for byte (SHA256 `991671790232ac4cccfdec37a64d2ff21c3910f1b85702a2f9b2d8cf0c9e4154`).
PR527 merged at `2bad3028d8b9d8c6fd403c8ae5fd2327534ec4f3`, 03:37:59 UTC October 22
(20:37:59 PDT October 21), after all three required checks passed and independent final-head review
found no blockers. GitHub also marked PR530, PR515 and PR477 merged through preserved ancestry.
Read Git status and coordinate before edits; never discard another agent's dirty files.

Combined local verification passed: lint, workspace typecheck and all 137 release tooling/package
tests, including repeatable Chrome/Firefox package bytes and the Safari version check. A separate
18-test trust run passed after the public JSON description correction; the key row still exactly
matches reviewed PR530. All 96 local links in the nine changed Markdown files resolve, privacy HTML
nesting is valid, the approved source hash matches, and `git diff --check` passes. Existing Svelte
build warnings remain in the release test log; no application source changed in this consolidation.
Logs: `/tmp/still-pr527-release-tests.log`, `/tmp/still-pr527-final-trust-tests.log`,
`/tmp/still-pr527-lint.log`, `/tmp/still-pr527-typecheck.log`.

Final [CI39714941729, attempt 2](https://github.com/ZackC-1/still-app/actions/runs/39714941729/attempts/2)
retained green main and Deno results. Deno passed 649 tests and 147 steps, with one gated test
ignored. The first browser attempt was canceled after six minutes stalled in pnpm self-installation,
before tests. Its retry passed all three phases: 367 with 37 skips, 212 with 192 conditional skips,
and 96 paid-tier free-outcome cases with one skip; no failed or flaky cases.

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
  guard with trust checks; current paid flags are not flipped. Final source CI passed as recorded above.
- Web canonical analytics SQL 0028, consent fences and actual Chrome/Firefox factory coverage pass
  focused tests and independent review. CI found closed deployment capability/manifest integration
  gaps; their exact allowlists are corrected and final source CI passed as recorded above.
- Apple optional analytics uses actual purchase provenance and canonical server-authored descriptors
  through a dedicated consent-fenced client lane. Generic queues still reject purchase events.
  The reviewed lock-order fix has a two-session SQL regression. Full iPhone simulator compilation
  passed, and arm64 Mac Debug compilation also passed. Both used signing disabled. PR528 tracks disposable PostgreSQL CI and protected deployment rehearsal evidence; final signed packages and production delivery remain separate pending gates.
- Apple optional attribution expires after 90 days; event delivery rejects events older than 30 days.
  Late or ambiguous refunds can be omitted. These are consented conversion subsets, not accounting.

Approved privacy publication [PR529](https://github.com/ZackC-1/still-app/pull/529) merged to gh-pages
at `e8a34d815aa7b0a7919bd20365d96e3d201ea4a0`, 03:38:24 UTC October 22 (20:38:24 PDT October 21).
Pages built successfully. Both [privacy.html](https://stillapp.fit/privacy.html) and
[privacy/](https://stillapp.fit/privacy/) returned HTTP 200 and matched the approved source SHA256
`991671790232ac4cccfdec37a64d2ff21c3910f1b85702a2f9b2d8cf0c9e4154`. The policy remains dated
October 21, the actual local publication day. App Privacy portal changes remain a separate gate.

Public trust pin [PR530](https://github.com/ZackC-1/still-app/pull/530), commit `08a37fc2`, matches
genuinely fetched hosted metadata on all three comparison checks and passed independent review.
PR530 merged through PR527 at `2bad3028`. This establishes configuration agreement; no runtime-signed access proof or
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

Five-route [analytics functions apply39722863701](https://github.com/ZackC-1/still-app/actions/runs/39722863701)
completed after the owner's personal approval. Its actual closing status is verified: two routes
created (`analytics-purchase`, `analytics-apple-purchase`), three deployed (`analytics-erasure`,
`analytics-identify`, `delete-user`), all five source/JWT read-backs passed, no issues and no recovery
needed. Exact plan digest: `3ffd97b1b88638bfa779cffebb4201d7f713d4d918a25f1cc041a07992dfd9d7`.
The existing secret, eraser and Vault readiness gates passed; no secret rotation or replay is needed.
Private closing record: `/tmp/still-analytics-functions-39722863701/production-closing-record.md`.

Direct [erasure-schedule apply39728922800](https://github.com/ZackC-1/still-app/actions/runs/39728922800)
completed after the owner's approval at `26bf5a947de9fef70102c9be87f1e69806cbce46`, policy `enable`.
Its actual closing status is verified: one `still-analytics-erasure-worker` job scheduled, no issues
or recovery needed. Exact plan digest: `be45dff44dbf23babddd30a9c8a46881733348031379ab587e7b8d035ac33df6`.
Private record: `/tmp/still-erasure-schedule-39728922800/production-closing-record.md`. Cron
installation does not prove an actual successful scheduled-worker run; that proof remains pending.

Checkout-repair [purchase-functions apply39729361809](https://github.com/ZackC-1/still-app/actions/runs/39729361809)
completed after personal approval at exact `26bf5a947de9fef70102c9be87f1e69806cbce46`. Its actual
closing status is verified: three routes deployed (`create-web-checkout`, `complete-web-checkout`,
`stripe-webhook`), six unchanged, all source/JWT read-backs passed, no issues or recovery needed.
Exact plan digest: `37c53dc48d7d8b74660a415ed9ab51f48cdb8ec622a11a1e28cb3fd59661268b`.
Migration/secret prerequisites and settings sync were unchanged. Private closing record:
`/tmp/still-checkout-repair-plan-39729361809/production-closing-record.md`.

All 13 safe hosted probes now pass, including both unsigned and invalid-signature Stripe POSTs
returning `400 invalid_webhook`. Private evidence:
`/tmp/still-checkout-repair-39729361809/postdeploy-negative-probes.json`. Fresh boolean-only
comparison confirms all 21 prepared payment values match hosted metadata, including the signing
secret. No secret values were output.

The previously approved conditional Stripe endpoint enablement completed after those gates passed.
Its actual proof is verified: live enabled status, intended URL, pinned version and five events
unchanged, with every other endpoint exactly unchanged. No synthetic delivery was sent. Evidence:
`/tmp/still-checkout-repair-39729361809/stripe-endpoint-enable-proof.json`. RevenueCat portal
settings remain unchanged. No real purchase/refund or positive webhook delivery is established.

The owner asked for approvals sooner:
avoid duplicate plan-only runs when the apply
already supplies the same gate. Global production concurrency and sequential operation requirements
remain unchanged. Reuse the verified existing analytics secrets unless a new problem is observed.

The future analytics-subjects switch must pin merged PR531 repair `26bf5a947de9fef70102c9be87f1e69806cbce46`,
not `2bad3028`, because that operation refreshes checkout too. Exact-revision settings/GoTrue
rehearsal39726287757 has passed at this pin. Final production-channel package gates still apply
before switch-on, alongside the actual successful scheduled-worker run and provider proof.

Owner screenshots confirm the active PostHog account-deletion key has **person: write** and
**project: read**, restricted to the intended Still project. The 19:37 PT Supabase screenshot
confirms exposed schemas are exactly `public` and `graphql_public`; `private` and `still_qa_checks`
are unchecked and `net` is absent. Discard client IP data was confirmed earlier. These resolve the
owner configuration questions, but do not replace the hosted provider proof.

The selected analytics functions and erasure schedule are deployed. Wait for an actual successful
scheduled-worker run, verify project/deletion permissions through
the runtime, then enable subjects. A dummy permission probe is not completed account erasure.

Secrets remain outside Git and chat. The public-only build trust handoff is
`/Users/zack/.local/share/still/production-payments-20261021/public-access-keys.json`.
Its hosted metadata comparison passed as recorded above; retain that evidence and verify the final packaged binding. Private prepared configuration and encrypted
read-only reports are in the existing owner-local locations recorded by the operational tooling;
do not print their contents. Mem0 retrieval quota and the claude-mem observer are exhausted;
repository evidence and the work-state list remain the active durable record.


## Dead-code audit advanced by the owner

The owner explicitly moved the audit to October 21, ahead of tomorrow's final screen/image work.
[PR532](https://github.com/ZackC-1/still-app/pull/532), head
`b3e6878c2c1148a73181b3e79770a944185e86a6`, contains the bounded cleanup and plan007 in
`/private/tmp/still-dead-code-audit-20261021`. It is open and waiting for verification, not merged.
Three audit lanes and independent adversarial review found no blocker. The 20 retired checkout
tests passed before deletion; active managed checkout, historical receipt and redaction coverage
remain. One duplicate Boolean assertion was also removed.

Remaining backend tests pass631/147steps (one gated ignore), deployment tests113, Safari405,
owner-admin58, app-webview19 and root Node58 (one design-reference skip). Final lint, typecheck
and build pass. All14 production upload bundles and114 web output files are byte-identical.
Three QA uploads differ only in consistent bound minifier-local renaming; their AST, literals,
external names and byte sizes match. All26 Edge Function entry graphs resolve. No production
or QA deployment was performed or required by this cleanup.

Keep the local baseline limits explicit: unbounded tests hit timing failures before cleanup;
Chromium's one lazy-view setup failure reproduces on clean26bf, and bounded core failures are
being compared/rerun without changing assertions or timeouts. CI39733615360 has passed its unit
step and Deno job; required browser verification and local fixtures are still running. Check
actual final outcomes before merging. The source review is bound to the immutable PR head.

After merge, new protected operations must pin the reviewed merged revision or a descendant and
pass that exact revision's settings rehearsal. The old26bf remains evidence of existing hosted
source, but deployment-tooling freshness prevents planning it against changed main.

## Next actions and blockers

1. Use reviewed main `26bf5a947de9fef70102c9be87f1e69806cbce46` for the checkout repair and future
   subjects switch. The completed analytics deployment remains bound to `2bad3028`; its five uploads and
   bound files are unaffected by the repair. PR527 and component
   PR530/515/477 are merged; PR529 is published and both live privacy paths match source. Migrations
   through 0029, purchase secrets, sync-settings, fresh DB-01 and PROD-01 remain complete
   as recorded above.
2. PR531 is merged with all 12 checks green, and the new exact-revision settings rehearsal passed.
   Checkout-repair apply39729361809 at `26bf5a94` is verified complete, all 13 safe negative probes
   pass, and the conditionally approved Stripe endpoint is enabled with other endpoints unchanged.
   Preserve the closing/probe/provider proofs and unchanged RevenueCat portal settings. Actual
   purchase/refund fulfilment and positive webhook delivery remain unverified until observed.
3. Analytics functions apply39722863701 and erasure-schedule apply39728922800 are verified complete.
   The worker job is installed; actual successful worker proof remains pending through the protected
   switch gates. Do not use arbitrary production SQL/CLI reads or writes to bypass those gates.
   Existing analytics secret/eraser/Vault readiness passed; no rotation or replay is needed.
   Avoid duplicate plan-only workflows when the direct apply already includes plan/rehearsal.
   Keep operations sequential under the global concurrency group. Each apply needs personal approval;
   never bypass protection with direct production CLI/SQL or self-approval. Handle partial/unknown
   outcomes before retrying.
4. Do not replay migrations through 0029 or unchanged settings sync. Preserve all previous receipts.
   Before the analytics switch, pin the merged PR531 repair SHA with passed exact-revision rehearsal
   39726287757; the switch refreshes checkout and must not restore `2bad3028` code.
5. Retain completed native compilation, disposable SQL/deployment evidence and actual production
   migration receipts. Any new migration requires a new exact plan; do not replay completed 0025–29.
6. Preserve the completed five-route analytics deployment and installed erasure schedule.
   Wait for an actual successful worker run
   and hosted project/deletion permission proof. Keep the subjects switch deferred until the owner's
   final production-channel packages satisfy the client-configuration gates. Then prove consent, identity, production event delivery and
   erasure with designated final-package checks. Genuine production customer fulfilment/refunds remain
   explicitly unverified until observed. PROD-02 is still a proposal, not an executable check.
   The three planned remaining approvals are the analytics identity switch, production sales and
   Apple review access. None is ready before final build gates; no owner permission is needed now.
7. Owner and Claude Code finish final screens/images on the morning of October 22, 2026. Final signed
   artifacts, release values, store declarations, device acceptance and sales activation follow.
8. The owner advanced the deep unused-code/test audit to now; PR532 is in verification. Prove obsolescence
   before removal, fix bugs rather than hiding failures, preserve meaningful coverage, and recheck
   affected artifacts. Do not claim size/performance improvements without measurements.

Use the [activation plan](../plans/2026-10-21-002-production-activation-and-verification.md),
[closed deployment procedure](../release/purchase-routes-and-secrets.md) and updated
[go-live runbook](../release/v3-go-live-runbook.md). Do not equate code merge, hosted deployment,
store approval, public availability and customer-delivery proof.
