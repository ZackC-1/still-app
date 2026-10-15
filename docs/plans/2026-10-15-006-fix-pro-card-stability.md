---
title: Keep the Still Pro card and lock chips steady (ISS-0032, ISS-0062)
type: fix
date: 2026-10-15
execution: code
---

# Keep the Still Pro card and lock chips steady

## Problem

Owner QA on the sandbox build (.361), for an account without Still Pro:

- Firefox desktop popup, signed out: no Still Pro card on the first opening; it appears on the second.
- Chrome popup, signed in and signed out: the card, and the "Still Pro" lock chips on Pro rows, drop
  out after a setting change or a sync cycle while the popup is open. Pro rows then show as plain
  disabled switches. Reopening brings them back.
- Safari Mac extension Settings page: no Still Pro card at all, while the Safari Mac popup shows one.

Expected: for an account without Still Pro the card and chips stay on first opening and through
setting changes and sync, signed in or out. They go away only on verified ownership. Nothing may
show Pro as owned or make a Pro row usable without verified entitlement.

## Root cause (evidence)

Two display inputs each treat "not sure right now" as "take the offer away":

1. **Offer readiness (Chrome/Firefox popup).** `PopupApp.svelte` asks the background "would Settings
   offer Get Still Pro?" (`checkoutAvailable`). It asks again on every committed-binding
   publication, which means every setting change and every settings sync write. Signed in, each
   answer is a fresh network sales check (`policy.freshCheck("sales")`); signed out it reads the auth
   session. Any failure, timeout or momentary unknown account state answers "no", and the popup set
   `proOfferReady = false`, which removes the card. At first opening (no cached answer) the popup
   tried three times within about 1.5 s. A Firefox background that is still waking up misses that
   window, and nothing asks again until something publishes.
2. **Access hold (all popups and settings pages).** `EntitlementCache` holds every non-free Pro row
   as `verification_required` when its access record changes, when a freshness deadline passes
   during a read, or when an observation fails (for example "Stale access context" after any auth
   event in the background, or an "Access observation expired" race). After a failed observation
   it waits 60 s before asking again. `proKnownMissing` is then false, so the card disappears and
   `FeatureRow` draws a disabled switch instead of the lock chip (the 2.56.54 PM screenshot).
   Holding a former `locked` row is deliberate in the entitlement design (a signed-in "none" is
   fresh evidence that expires), so the display layer, not the authority, should decide that a hold
   after a conclusive "locked" is just Still re-confirming.
3. **Safari settings page.** `SafariV3Options.svelte` supplies no Still Pro card by design note
   ("no price, purchase or paywall on this surface"), but the Safari popup does hand off to the Still
   app with a price-free card. The two Safari surfaces disagree.

## Approach

- **Display latch (core, presentation only).** `presentation.ts` gains `createProOfferLatch()`.
  Once a view has seen Pro access conclusively locked, a later hold (`checking` or
  `verification_required` on Pro rows, with no Pro row purchased or protected) is shown as
  `locked`. Any purchased or protected Pro row (verified ownership), or a Pro row turning
  `unsupported`, ends the latch at once. DesktopPopup, MobilePopup and ExtensionSettings render from
  the latched snapshot. Commands still use the binding's real snapshot, and a locked row has no
  switch, so a hold can never make a Pro row usable.
- **Offer readiness (Chrome/Firefox popup).** A live "yes" in this popup stays for the popup's life;
  later publications do not re-ask (checkout still runs its own fresh check). Before the first yes,
  retries back off over about 7.5 s (0.5, 1, 2, 4 s) and every publication restarts that
  schedule. A first live "no" still overrides a remembered "yes" (unchanged).
- **Faster access recovery after a failed observation (core cache).** After a failed observation
  the cache retries after 1, 2, 4 and 8 s before falling back to the 60 s cadence; any success
  resets it. This bounds how long a first opening can stay without an answer. Nothing else in the
  hold logic changes.
- **Safari settings page.** `ExtensionSettings` gains an optional `proHandoff` (used only when no
  `pro` producer is given). With conclusively locked access it shows the same compact Still Pro card
  as the Safari popup ("Get Still Pro", "Opens the Still app"; no price), and the lock chips open the
  app. `SafariV3Options` supplies it through the existing `createSafariAppHandoff` (Mac: native
  route; iPhone/iPad: the fixed `still://pro` tab). The settings tab is not closed. Paid-off builds
  keep every Pro row `unsupported`, so nothing appears there.

Out of scope: SettingsCache write/authority logic (ISS-0050 lane), entitlement authority rules,
the paid-tier flags.

## Tests first

- Popup (Chrome and Firefox): first opening with readiness replies that fail three times or arrive
  late shows the card without reopening.
- Popup: after the card shows, a setting change whose re-ask would answer "no" keeps the card.
- Popup, signed in and signed out: a sync cycle that holds access (record change plus a failed
  observation) keeps the card and the lock chips; lock tap still only navigates.
- Popup: verified ownership (purchased) removes card and chips (control).
- Cache: a failed observation retries within seconds, not 60 s.
- Settings (core): the latch keeps the Still Pro card through a hold; `proHandoff` shows the compact
  card and live lock chips; none for purchased or unsupported access.
- Safari settings page: the host passes `proHandoff`; on Mac it opens `still://pro` through the app.

## Retest (owner)

CH-05/06, FX-06, CH-49, CH-59, FX-43, FX-48, AND-04/05, MAC-43 (Chrome side), and the Safari Mac
Settings page opened from the TikTok blocked page (signed in): the Still Pro card shows.

## Risks

- A latched offer may stay for a moment after a purchase made elsewhere until the purchase is
  verified. That matches "hide only on verified ownership"; the destination re-checks.
- A sales switch-off while a popup is open is not reflected until the popup reopens; checkout still
  refuses.
