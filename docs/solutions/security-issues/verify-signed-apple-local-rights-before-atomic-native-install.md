---
title: Bind signed Apple local rights to native transaction identity before atomic installation
category: security-issues
track: feature
problem_type: authentication_error
module: StillKit
applies_when: Installing server-issued Apple local access proofs or linked account rights in the shared App Group
date: 2026-10-07
last_updated: 2026-10-08
status: active
tags:
  - entitlement
  - apple
  - signed-proof
  - atomic-storage
---

A paid Apple local proof uses a server-issued UUID as both right and holder. Native StoreKit does not know that UUID. Accepting the UUID from JavaScript, or treating a receipt Boolean as a mapping, would bypass the holder check. Installing an account proof by right UUID alone also overwrote the independently valid local proof when both scopes represented the same purchase.

[AppleRightBinding.swift](../../../apps/apple/StillKit/Sources/StillKit/AppleRightBinding.swift) verifies a separate signed canonical binding between the right UUID and environment, bundle, product and original transaction ID. The verifier shares the access-proof envelope/key checks but uses the distinct `still-apple-right-binding-v1` signing domain. The native purchase oracle independently reads a current verified StoreKit transaction and rejects revocation, unsupported environment and mismatched metadata. Purchased ownership is required for account installation and the explicit link evidence port. A separate local evidence port permits verified family-shared ownership for local installation only. Original transaction IDs remain strings across the transport.

[NativeAccessConfiguration.swift](../../../apps/apple/StillKit/Sources/StillKit/NativeAccessConfiguration.swift) reads an explicit environment-bound public-key allowlist and auth endpoint from the code-signed bundle. Its empty defaults reject installation. Linked account installation uses the exact token accepted by that native endpoint, matching confirmed account and native session identifiers, plus the App Group generation and router account lineage. Display-only account UUIDs are insufficient authentication.

[EntitlementBridge.swift](../../../apps/apple/StillKit/Sources/StillKit/EntitlementBridge.swift) commits the verified binding, local proof, clock and optional account proof under the existing transaction lock. Scope identity is right plus proof kind, so account and local proofs coexist. Failed replacement publishes no acknowledgment and preserves old bytes. Identical proof retries preserve the original receipt baseline and expiry/rollback latches. Signed-out reads derive local rights from persisted verified bindings, without needing JavaScript holder IDs.

The bridge acknowledgment includes exact signature identities and signed right/revision/times. [apple-session.ts](../../../packages/core/src/sync/apple-session.ts) reports an explicit association only after validating that durable native acknowledgment. The native observation transport distinguishes purchased rights from verification-required rights and rejects unknown fields, malformed signatures and duplicate UUIDs.

Account reconciliation has two independent outcomes: a durable cache commit and the hosted
account authority's status. A removal-only `unavailable` response can successfully commit a
known refund while leaving an unrelated cached purchase valid. Preserve both `status: committed`
and `accountStatus: unavailable` across the Swift/TypeScript acknowledgment. Treating the commit
as fresh account confirmation made Restore report success from those cached benefits without
trying StoreKit. The Apple purchase authority now observes the updated cache, then rejects the
unavailable reconciliation so Restore keeps accepted rights and still tries its independent local
purchase path. Regression coverage includes durable removal and cold reopening, strict bridge
status/proof combinations, and a mounted Restore with a purchase cached before the UI observes it.
An ownership conflict with no accepted proofs is similarly unresolved. It must reject fresh
account confirmation after the removal commit; accepted proofs in a partial conflict and a
conclusive empty `none` result remain usable. Factory and mounted Buy/Restore regressions show
that an empty conflict neither starts a charge nor reports cached rights as freshly restored.

Account replacement also cannot discard a StoreKit request already dispatched. Keep a separate
native acquisition generation until Apple replies, blocking overlapping Buy and Restore. A stale
completion retains only recovery intent, and a current signed local read establishes rights.
Confirmed cancellation releases the hold; a lost native reply retains verification rather than
starting another purchase. Deferred Buy/Restore, cancellation and lost-reply tests cover these
boundaries without granting rights or linking the replacement account from store feedback.
The stale-completion path distinguishes confirmed pre-dispatch `unavailable` and conclusive
empty Restore from unknown acquisition feedback, retaining any already-pending purchase intent.
`failed/noSignal` must stay held: the bridge also uses it for malformed responses, so it cannot
prove that no charge occurred. Regression controls cover retry after a confirmed refusal and
continued hold after a lost or malformed reply.
The repaired tree passed 437 StillKit tests and 4,766 core tests; synthetic tests do not establish
provider or physical-device behavior.

Modern account reconciliation starts after the queued native account-status write succeeds for
the current session. Return a per-write success result from that queue: swallowing a failed write
to let later writes recover must not make its purchase continuation run. Free settings sync and
code verification complete independently. A regression reproduced the failed-write continuation;
the repaired flow holds purchase reconciliation while the existing free sync still completes.

Verification: 403 StillKit tests pass, including eleven new security cases in [AppleRightBindingTests.swift](../../../apps/apple/StillKit/Tests/StillKitTests/AppleRightBindingTests.swift). Thirty-one focused TypeScript tests pass for exact bridge input/readback and deliberate association. These tests use public synthetic keys. They establish local cryptographic, clock, storage and transport behavior; deployed provider trust configuration and physical StoreKit/device journeys require separate evidence. The ordinary free mode and disabled shipped paid flags retain their existing behavior.

Current entitlement enumeration alone excludes refunded/revoked purchases, so the native absence observation also checks the latest catalog transaction history before declaring no purchases. A completed empty snapshot permits the first purchase offer; unverified, timed-out, or existing history keeps verification required. The observation stays within the web deadline. See Apple’s [current entitlements](https://developer.apple.com/documentation/storekit/transaction/currententitlements) and [latest transaction](https://developer.apple.com/documentation/storekit/transaction/latest(for:)) contracts. Native capability support separately matches the six implemented Safari extras; a signed twelve-benefit purchase never enables unsupported controls.

A StoreKit-verified transaction with a real revocation date is a conclusive revocation observation. The native oracle publishes it immediately, including when a later catalog read times out. The existing atomic cache matches its environment, bundle, product and original transaction ID against verified signed bindings and persists a revocation marker on the matching binding. A purchased refund latches both paid local/account clocks; loss of family-shared access latches only the local paid scope. Unrelated paid rights and permanent protection survive, including protection sharing the same UUID. Cold reads and replayed signed proofs cannot clear a purchased-refund marker. Unverified, unavailable and mismatched observations do not revoke a cached right. Regression tests cover both paid scopes, cold reopening, replay, failed durable writes and identity mismatches.

The native family-local recovery boundary permits a fresh signed proof only after its signed verification time exceeds the local family-removal time and current native verification confirms nonrevoked family ownership. It leaves account clocks and generation unchanged. Old proofs, unknown ownership and purchased-refund markers cannot recover. This conditional cache rule does not establish an end-to-end rejoin: the issuer's first-refund tombstone currently prevents a new proof for the same original transaction. Actual sandbox sharing removal/rejoin and transaction identity must be verified before making a recovery claim. Apple's [Family Sharing guidance](https://developer.apple.com/documentation/storekit/supporting-family-sharing-in-your-app) and [sandbox test procedures](https://developer.apple.com/documentation/storekit/testing-family-sharing) define the provider journeys.


Sample paid-access wall time inside the actual backing transaction, after its cross-process lock
is acquired. Evaluating `now()` before lock admission lets a queued Safari read commit an earlier
sample after a newer app read; the rollback defense then mistakes scheduling order for a clock
rollback and permanently pauses a valid right. Store access operations accept clock-producing
Swift autoclosures and evaluate them inside the transaction. A deterministic queued-reader
regression failed before this repair; real subsequent backwards clock movement still pauses.

An exact already-committed signed identity may retry a lost acknowledgment after the five-minute
initial-install freshness window without creating a receipt baseline. Native ownership, signature,
expiry, account generation and revocation/rollback latches still validate. New or changed proofs
retain the original freshness bound. Revoked historical bindings do not compete with a verified
purchase under a new original transaction ID when selecting active ownership. Purchased-refund
markers continue to reject replay of the matching refunded identity. The retry and historical-selection regressions failed before
their repairs; all 414 StillKit tests passed afterward. These synthetic checks do not prove that
Apple actually issues a new original ID for any particular repurchase or family-rejoin journey.

The router's process-local revocation fence remembers successfully committed observations by
environment, bundle, product, original transaction ID, ownership and revocation time. A repeated
settled historical refund must not advance the install generation: otherwise a current purchase's
own catalog scan invalidates its captured generation and account linking never recovers. A new
verified refund advances the fence before storage, including when no binding exists yet. Failed
commits remain pending and block installation until retry succeeds; family and purchased removal
are distinct observations. A regression using the extracted production fence failed before the
repair, then passed alongside 417 StillKit tests and unsigned iOS/macOS builds. Independent Claude
review approved the repair. This helper regression establishes the fence behavior, not a live
StoreKit or complete WebKit-router journey.
