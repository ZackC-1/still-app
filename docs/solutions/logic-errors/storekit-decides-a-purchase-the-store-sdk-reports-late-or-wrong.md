---
title: StoreKit decides a purchase the store SDK reports late or wrong
category: logic-errors
track: bug
problem_type: logic_error
module: apps/apple/Still/Shared (App)/Purchases/PurchaseManager.swift
applies_when: Mapping a native Apple purchase, Restore or bounded bridge wait into what the page shows, or reading a background right install into the settings screen
date: 2026-11-07
status: active
tags: [apple, storekit, revenuecat, purchase, entitlements, ISS-0134, ISS-0136, ISS-0137, ISS-0138, ISS-0139, ISS-0140]
---

# StoreKit decides a purchase the store SDK reports late or wrong

TestFlight 3.0 (13), production backend, owner QA on 7 November 2026:

- ISS-0136 (blocker): a signed-in sandbox purchase the owner confirmed on Apple's sheet ended at
  "The purchase wasn't confirmed. If you were charged, Restore purchase will find it." PostHog had
  `purchase_started` then `purchase_failed reason unknown` 15 s later. The production functions saw
  no `verify-apple-access` call. Tapping Restore purchase then verified the same purchase (HTTP 200)
  and unlocked Still Pro.
- ISS-0134 (minor): a sheet left to time out came back as "Your purchase needs to be verified."
  with no `purchase_cancelled`; the `purchase_failed reason unknown` arrived 121 s after
  `purchase_started`.
- ISS-0137 (major): on the Mac, the launch-time local verification installed a device right in the
  background, but the Pro card kept "Still Pro needs to be verified again." until a relaunch.

## Root causes

**ISS-0136.** The card copy "wasn't confirmed" without a verify line is reachable only through the
host's catch with no pending verification (`apple-pro-host.ts` `transact`). A rejected or slow
bridge reply becomes `pending` (`boundedNativeRead`), and a thrown verification keeps the verify
line, so both are excluded: native replied `outcome: "failed"` after the sheet. The only post-sheet
`failed` is the store SDK's `purchase(package:)` throwing after Apple completed the charge
(`PurchaseManager.purchaseStillPro` catch). Its reply still carried `receipt: entitled` and
`productId: still_pro_v3` (the post-purchase receipt read), and both `ApplePurchaseActionResult`
and the web `parseProResult` ignored the receipt for a failed outcome, so the host threw and never
ran the local verification that Restore runs from the same `verifyLocalPurchase`.

A second path fits the same evidence and cannot be told apart without logs: the router's
`purchasePro` reply was refused by the revocation fence (`accessRevocations.ready` false after a
verified revocation, such as a refunded historical `still_sync`, whose durable commit failed once;
that route never retried the commit before its guard). The bridge turned the refusal into
`pending`, the host ran `verifyLocalPurchase`, whose evidence read the same closed fence refused
before any network call, and the catch produced `purchase_failed reason unknown` with both the
"wasn't confirmed" and the verify lines on the purchase screen. Restore then succeeded because its
stamp refresh retries pending commits first. Both paths are closed; the new logs name the one that
ran.

**ISS-0134.** `PurchaseManager.purchasePro` bounded one page wait at 120 s with
`fallback: .pending`. `pending` means "the store accepted, verify later", so the host set a pending
verification, ran it, found no transaction, and showed the sticky verify copy. The 121 s gap in
PostHog is that bound.

**A plain cancel was a failure too.** In purchases-ios 5.79.0 the orchestrator forwards
`purchaseCancelledError` as the completion's error on a user cancel ("to match SK1 behavior",
`PurchasesOrchestrator.swift:693`) and the async bridge `purchaseAsync(package:)` resumes with
`Result(customerInfo, error)` (`Misc/Concurrency/Purchases+async.swift:85`), which throws whenever
the error is non-nil. So the async `purchase(package:)` throws on a plain cancel and
`result.userCancelled` is never seen on that path; the catch mapped it to `.failed`, which the
page showed as "wasn't confirmed" with `purchase_failed`.

**ISS-0137.** `main.ts` ran `authority.verifyLocalPurchase()` at launch, which installs the right
natively and reads benefits directly, while the screen reads the settings authority's
`EntitlementCache`, which next asks native at its minute refresh. Nothing told the cache a right
had just been installed. The code does not explain the further minutes the owner saw; the new
native log lines (`access: benefit read with StoreKit ...`, every `bridge: ... refused: ...`) show
what each minute read resolved or which guard refused it.

## Fix

- StoreKit is the authority after an SDK failure. `AppleSDKPurchaseFailure.classify` (StillKit,
  tested) reads a thrown SDK purchase against the sellable receipt again: entitled after a
  conclusive pre-flight (a real "no transaction" or a refund; `ReceiptRead.conclusive` is false
  for a timed-out or unverifiable read) is this charge and is reported `purchased` with the same
  new-purchase evidence (`AppleNewPurchaseProvenance.rescuedEligible`: new against the pre-charge
  read, production, purchased, unrevoked; no SDK completion id exists on this path); entitled after
  an inconclusive pre-flight may be an older purchase and goes to the local verification as
  `pending`, never counted as a sale; without a receipt the SDK's cancel error is `cancelled`, its
  Ask-to-Buy error `pending`, anything else `failed`. `ApplePurchaseActionResult` and
  `parseProResult` both map a `failed` or `staleIdentity` with an entitled `still_pro_v3` receipt
  to `pending`, so the page verifies locally. The host's own `failed` Buy branch runs
  `verifyLocalPurchase` once before showing "wasn't confirmed": owned is the purchase, a held
  install keeps verification recovery, nothing on the device keeps the failed card with Try again,
  never a verify state.
- A bounded wait is `unsettled`, never `pending`. The host waits again with
  `purchasePro(offer, { join: true })` for as long as native says the purchase is in flight; native
  answers a join from the task already running, or from the result that settled meanwhile
  (`unclaimedPurchaseResult`), never a second charge. Each wait is itself bounded, so nothing spins,
  and only StoreKit's real answer ends the attempt: a late confirmation is verified and counted, a
  closed sheet is one `purchase_cancelled`, and `purchase_failed` is never emitted for a wait.
- A refused purchase or join reply is `pending`, never `unsettled`: `boundedNativeRead` maps a
  rejection separately from a timeout, so the host verifies the device instead of joining again
  into the same refusal (which spun the loop and, once the fence cleared, ended a real charge as a
  cancel). The router's `purchasePro` and `restorePro` retry pending revocation commits before the
  fence can refuse their reply, as the other routes do, and a native join reads the settled result
  without clearing it, so a refused delivery cannot lose it; only the next purchase start replaces
  it.
- `createAppleSettingsAuthority` takes `pendingLocalVerification`; when it fulfils, the cache is
  read twice (finish any read in flight, then read the committed record). `main.ts` passes the
  launch verification.
- `staleIdentity` is refused before any charge, so the page now says nothing was charged.
- Evidence reads retry pending revocation commits before the fence can refuse them, and every
  refusal on the purchase, Restore, evidence and benefit paths is logged with its fixed reason and
  the fence state (no identifiers).

## Rule

A store SDK's error after Apple's sheet is not the outcome; the device's verified receipt is. Any
reply that carries an entitled sellable receipt goes to the same local verification Restore uses,
and it counts as a new sale only when the pre-charge read conclusively showed none. Read the SDK's
cancel from its thrown error: the async purchase API never returns `userCancelled` for a plain
cancel. A bounded wait that ends before the store answers is unknown, not accepted and not a
cancel: never label it `pending`, and keep waiting while the store says the purchase is in flight.
A refused reply is not a wait: it comes after the store may have settled, so verify the device
rather than ask again, and never let a reply guard drop a result the page can no longer fetch.
When native changes the access record in the background, hand the page's cache a reason to read
again instead of waiting for its timer.

## Verification

- StillKit `swift test`: 556 tests, 0 failures, including `AppleLifetimeOfferingTests`
  (failed+entitled is pending, unsettled passes through), `PurchaseDecisionTests` (the SDK failure
  rule: conclusive pre-flight, cancel, Ask-to-Buy), `AppleNewPurchaseProvenanceTests` (the rescued
  rule) and `PurchaseConfirmationWiringTests` (the app wires the rule, the cancel error, the
  rescued evidence, the unsettled bound, the join, the evidence retry and the logs).
- `apple-pro-host.test.ts`, `apple-pro-host.integration.test.ts` and `native-pro.test.ts`: the
  rescue through local verification, the failed card without a verify state, the unsettled join
  loop that waits through many joins and takes the real cancel or purchase, the stale-identity
  copy, the bridge mapping. The compiled purchase harness (`native-purchase-sales.test.ts`) still
  compiles the extracted `purchaseStillPro` and proves its charge ordering.
- `apple-settings-host.launch-verification.test.ts`: the cache reads again when the launch
  verification installs a right, finishes an in-flight read first, and reads nothing after stop
  or a rejected verification.
- Device QA still has to confirm: which SDK error domain and code the sandbox purchase produces
  (now logged), that the purchase completes on iPhone build 14, and what the minute benefit reads
  resolve on the Mac.

## Build 14 follow-ups (device QA, 10 November 2026)

TestFlight 3.0 (14), production backend, sandbox purchases:

- ISS-0137 again, iPhone: delete, reinstall, onboarding, signed out, the Apple Account already
  owns `still_pro_v3`. `verify-apple-access` answered 200 during onboarding, yet the Pro card kept
  "Still Pro needs to be verified again." until a force quit and relaunch. On the Mac the build 14
  re-read showed the right within seconds.
- ISS-0138: signed in with an Apple Account that is not a TestFlight tester. Apple refused the
  purchase before any sheet ("not authorized to make purchases of this InApp in Sandbox"). The page
  showed "Your purchase needs to be verified." with a Verify purchase that did nothing (no function
  call, no event); PostHog had `purchase_started` and nothing after it.
- ISS-0139: signed in, purchase confirmed and verified (200), Pro rows working, then the link card
  said "Linking didn't finish." with Try again. `link-apple-access` was never called, before or
  after Try again, and after Try again the card simply disappeared.
- ISS-0140: no `purchase_completed` for the confirmed purchase and no `purchase_failed` for the
  refusal; no `analytics-apple-purchase` call.

### Root causes

**ISS-0138, the sticky verify state.** The settings host calls `accountChanged()` whenever the
controller's `userId`, email, revision or `accountConfirmed` changes, and `accountChanged` bumped
the host's epoch and cleared `busy` unconditionally. `accountConfirmed` is derived from a
confirmation the controller clears and re-reads on every foreground (`refreshAccountConfirmation`
sets it to null first), so the same signed-in account "changes" twice around any foreground. A
purchase whose sheet was up at that moment landed in the host's "account replaced" branch, where a
`failed` reply became `pendingKind = "buy"` and `purchase = pending` with no outcome event. The page
then read "needs to be verified"; Verify purchase ran `refresh()`, whose `verifyLocalPurchase` found
no transaction on the device and rejected before any network call, and `refresh()` showed nothing
for a rejected verification. On the native side the store's pre-payment refusal
(`purchaseNotAllowedError` and its kin) was only ever `failed`, so even without the epoch bump the
page could not say that nothing was charged.

**ISS-0139, the link that never asked the server.** Since the sandbox review isolation
(`APPLE_SANDBOX_REVIEW_ENABLED`, 21 October), a sandbox transaction verified against the production
function gets a schema-2 "sandbox review" binding, which native excludes from link eligibility
(`observeAppleLinkAccess` skips `isSandboxReview` bindings) and the server refuses to link. Every
TestFlight purchase is such a right. The host's post-purchase `linkPurchased` read eligibility, got
native's settled "no linkable right" (null), and `confirmLink` turned that fact into "Linking didn't
finish" with a Try again that could only read the same answer; a later eligibility refresh with
the same null then cleared the card. Two more faults sat on the same path: the authority's
`readLinkEligibility` returned null for a read overtaken by a newer one (a race the automatic link
runs into whenever the cache publishes right after the install), indistinguishable from "nothing to
link", and `accountChanged`'s confirmation flicker cleared a failed link card outright.

**ISS-0140, the missing outcome.** The Apple host never emitted `purchase_completed` at all (only
the server-authored `purchase_recorded` existed for Apple sales), and the two "account replaced"
branches emitted nothing for any outcome. `analytics-apple-purchase` is called only for a production
transaction with new-purchase evidence; a sandbox purchase never reaches it, by ADR 0004's rule.

**ISS-0137, iPhone.** The settings screen depended on one promise, the launch verification
`main.ts` starts before onboarding, to learn that a right was installed. On the fresh-install path
that attempt runs while onboarding is shown and the person leaves for the Settings app; whatever
ended it (a lost reply, a refused install, a read the fence refused), nothing retried it until a
relaunch, and the screen's own `refresh()` only re-read the cache. The Console lines from build 14
(`bridge: installAppleAccess committed`, `access: benefit read with StoreKit`) say which step it was.

### Fix

- Native: `AppleSDKPurchaseFailure.classify` takes `sdkReportsRefusal`; the store SDK's
  pre-payment codes (`purchaseNotAllowedError`, `purchaseInvalidError`,
  `productNotAvailableForPurchaseError`, `ineligibleError`) without a verified receipt are
  `refused`, mapped to the page's `unavailable` ("refused before any charge": the existing
  "Still Pro couldn't be bought right now. Nothing was charged." copy and one
  `purchase_failed reason not_allowed`). A store problem, a network error or an unknown error
  keeps the receipt rule and the "if you were charged, Restore purchase will find it" answer.
- Host: `accountChanged` cancels in-flight work only when the account's id, revision or address
  changed; a re-confirmation of the same account changes nothing. A `failed` reply after a real
  replacement is verified on the device like any other. Every Buy that reached the store reports
  exactly one outcome event (`purchase_completed`, `purchase_cancelled`, `purchase_pending` or
  `purchase_failed`) from a single place at the end of the attempt. An explicit Verify purchase that
  cannot verify shows the existing check failure line ("We couldn't finish checking. Nothing
  changed.", Try again verifies again) and keeps the hold.
- Host: when a `refresh()` (mount, foreground, Verify purchase) reads "verify again", the screen
  verifies the device itself, after the launch's own attempt has settled (`launchVerification`,
  from the settings authority's `localVerification`), at most once at a time. Nothing to verify,
  offline or refused keeps the card with its own way back.
- Link: the authority's `readLinkEligibility` rejects an overtaken read (no answer) and returns
  null only for native's settled answer. `confirmLink` treats a settled null as "nothing to link"
  (the card and the affordance leave, no server call, no Try again) and a thrown read as a failure
  with Try again, which links the same holder as signed in now. The holder, not its confirmation
  flicker, carries a link through.

### Rule additions

A confirmation the controller re-reads is not an account change: only id, revision and address
say an account was replaced. A refusal the store makes before any payment is conclusive and says
nothing was charged; everything after the sheet keeps the receipt rule. One purchase attempt, one
outcome event, reported where the attempt ends. A screen that reads "verify again" verifies the
device itself; a one-shot launch promise is not a recovery path. Native's settled "no linkable
right" is a fact to show as such (a sandbox review right is never linkable), and a read that could
not be made is the only link failure worth a Try again.

### Verification (build 15)

- StillKit `swift test`: `PurchaseDecisionTests` (the refusal rule, cancel and pending still win,
  the default keeps the receipt rule) and `PurchaseConfirmationWiringTests` (the refusal codes, the
  `refused` outcome and its `unavailable` mapping in both routers).
- `apple-pro-host.test.ts`: a same-account re-confirmation while Apple's sheet is up (refused,
  failed, confirmed and linked), a replaced account's refusal, Verify purchase that answers, one
  outcome event per attempt for every native reply, the held right verified by the screen (after
  the launch attempt, once at a time, never for owned, locked or a historical holder's sign-in),
  the settled nothing-to-link, the overtaken read asked again, Try again after a confirmation
  flicker. `apple-purchase-authority.test.ts`: an overtaken read rejects. All of these fail against
  the build 14 sources.
- Device QA on build 15 still has to confirm: iPhone fresh install signed out shows Still Pro
  without a relaunch; the non-tester Apple Account refusal comes back as "nothing was charged" with
  one `purchase_failed` (the Console line `purchase: store SDK threw <domain> <code>` says whether
  Apple reported it as a pre-payment refusal or as a store problem); a signed-in sandbox purchase
  ends with "Still Pro on this device" and no link card; `purchase_completed` arrives once.

## Related

- [Preserve restore feedback through local purchase verification](preserve-restore-feedback-through-local-verification.md)
- [A historical product must never feed device-only purchase proof](historical-products-never-feed-device-only-proof.md)
- [Verify signed Apple local rights before atomic native install](../security-issues/verify-signed-apple-local-rights-before-atomic-native-install.md)
