---
title: An accountless Apple Still Pro holder who signs in is offered the link (ISS-0076)
date: 2026-10-18
status: active
issue: ISS-0076 (major)
related: ISS-0071 (D543, ADR 0005), docs/plans/2026-10-16-007-feat-apple-signin-before-buy.md
---

# An accountless Apple Still Pro holder who signs in is offered the link

## Problem

On the Mac app (2.1.1.383), a device holding an accountless Apple Still Pro right showed the
invitation "Sign in to keep Still Pro with your account." Clicking Sign in and entering the code
landed on the main screen with the address, the Still Pro tag and "Synced with your account.", but
no "Link Still Pro to this account?" confirmation. After quitting and reopening there was nothing
to link with either. Reproduced twice (owner, 18 October). The database checks confirmed nothing
had linked silently: the right stayed accountless, ownership revision 0, no link operation.

The iPhone app shares the whole path (`AppleSettingsHost.svelte` and `apple-pro-host.ts` are the
same code on both), so the fix covers both.

## Root cause (evidence)

The invitation's Sign in calls `requestLink()` in `packages/core/src/ui/v3/apple-pro-host.ts`.
Signed out, that parks a `linkingRequested` flag and opens the sheet; `accountChanged()` was meant
to pick the flag up once the account confirms and show the confirmation. Three things in the same
module defeated it, all of them started by the sign-in itself:

1. **Every eligibility re-read began by erasing the answer.** `refreshLinkEligibility()` set
   `eligiblePurchase = null` before asking native, and a read overtaken by a newer access snapshot
   returned without restoring it. Sign-in republishes access (the account reconcile advances the
   native record generation, so the cache publishes a new snapshot) and each snapshot starts a
   re-read. When the confirmed account arrived, `requestLink()` either bailed at once on the
   empty answer or awaited its own read, which the next snapshot fenced, and then bailed. The
   request flag stayed set, but nothing ever re-offered it.
2. **Any non-owned snapshot dropped the request.** `observeAccess()` called `clearLink()` for
   "checking" and "verify" as well as "none". The entitlement cache publishes a held
   ("verification_required") snapshot whenever a refresh is in flight past its 60 s deadline
   (`currentAccessSnapshot()` → `holdAccess()`, reached from the popup binding on every settings
   publish). A hold during the minute the person spends on the sheet erased the request.
3. **Nothing re-offered a request once access was owned again.** Only `accountChanged()` looked
   at the flag.

The instrumented host integration test (`apple-pro-host.integration.test.ts`, "signing in from the
invitation…") reproduces the first mechanism once the fixture advances the native generation on
reconcile and lets the held eligibility reads finish one at a time, as StoreKit answers do on a
device. In a single flush all three reads resolve together and the request's continuation sees the
answer the last read wrote, which is why a naive fixture stays green.

A fourth, smaller point: after a plain sign-in the only way to link was a plain text link at the
very bottom of the screen, below the help links ("Link Still Pro to an account"). The owner did not
see it. The QA programme expects a card.

## Change

`packages/core/src/ui/v3/apple-pro-host.ts`:

- A requested link is remembered before any read, and only a conclusive answer drops it: nothing
  owned (a "locked" snapshot), nothing eligible (a settled null from native), the sign-in sheet
  closed signed out, or another account. "checking" and "verify" snapshots keep it.
- `refreshLinkEligibility()` keeps the last settled answer while a read is in flight or access is
  being re-checked; a settled answer replaces it. A settled eligible answer re-offers a requested
  link whose account has confirmed (`offerRequestedLink()`), whichever of owned access and the
  provenance lands last. The request's own read does not re-offer (no recursion).
- `requestLink()` asks for sign-in at most once per request (`linkSignInAsked`), so the re-reads
  cannot reopen the sheet. `signInDismissed()` drops a link request when the sheet closes signed
  out: a later sign-in shows the link card, never a surprise confirmation.
- Confirming while access is held reports "Linking didn't finish." with Try again instead of doing
  nothing; Try again re-offers the confirmation once access is owned again.
- Nothing links without the confirmation tap, as before; `canLink` and the guarded `confirmLink`
  re-read eligibility before any link.

`AppleSettings.svelte`, `apple-settings-presentation.ts`, `AppleSettingsHost.svelte`:

- The invitation card has a signed-in form: "Link Still Pro to your account." with Link and Not now
  (`linkInvitation.signedIn`). Link runs the same explicit link, which ends in the existing
  "Link Still Pro to this account?" confirmation; the offer yields to that card. Not now hides the
  card until the app is next opened, as the signed-out invitation already did.
- The bottom text link below the help card is gone; the one on the Still Pro screen stays.

No Swift, server or sync change. Chrome and Firefox are untouched.

## Verification

Red first (saved before the fix, `iss0076-red.txt` in the session scratchpad): 11 of 12 new tests
failed, across `apple-pro-host.test.ts` (seven host tests: a hold during sign-in, a hold after
confirmation, an in-flight re-read when the account confirms, no blink of the affordance, the sheet
closed signed out, no link without the tap, confirming during a hold), `AppleSettings.test.ts`
(the signed-in card) and `apple-pro-host.integration.test.ts` (plain sign-in shows the card, Not
now, cancel drops the request). The invitation → sign-in → confirmation integration test went red
once the fixture released the held eligibility reads one at a time (`iss0076-red-integration.txt`).
The guard test (conclusively locked access drops the request) passed before and after.

After the fix: the three files pass (265 tests), StillKit `swift test` is untouched by this change.
Repository gates: see the package card for this build and the PR.

## Second fix (18 October, afternoon; PR467)

The automated Mac lane on package 2.1.1.385 found the invitation's sign-in still ending on the
signed-in offer card, and "Link to this account" ending in "Linking didn't finish" twice; the
read-only DB-17 check showed no link operation reached the server. One path was still treated as
conclusive: native refuses the link-eligibility read while the sign-in's reconcile is in flight
(and again at confirmation), and `refreshLinkEligibility` turned the refusal into "not eligible",
dropping the request; inside `confirmLink` the single re-read turned it into a failure.

Change (`apple-pro-host.ts`): a refused read is no answer (the last settled answer and the request
stay; the next snapshot or refresh asks again); the confirmation retries one refused read and, like
the automatic link, re-reads once more when an access refresh lands during the first read. Tests:
two host tests (refusal during sign-in; refusal after the account confirmed) and a real-host
integration test where the reconcile refuses the reads, red before the change; the fence test was
re-phrased for the extra read. Package 2.1.1.387 carries it.

## Owner retests

MAC-85, MAC-86, DB-39 (DB-17 with account=delete), MAC-87, and the iPhone equivalent of the
invitation → sign-in → confirmation path, on the fixed package. Also: a plain sign-in from the sync
card as an accountless holder shows "Link Still Pro to your account." (Link / Not now); Not now
hides it until the next launch; nothing links without "Link to this account".

## Not done

- Native does not tell the web view which account a right is already linked to, so a holder who
  linked and relaunches signed in to that same account sees the offer again until Not now (tapping
  Link ends in "Still Pro is linked to …" through the server's `already_linked`). A later change
  could carry the linked account in the native rights observation and hide the offer.
