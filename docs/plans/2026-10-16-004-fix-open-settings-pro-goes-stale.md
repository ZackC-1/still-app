---
title: An open Settings page keeps its Still Pro answer fresh (ISS-0072)
date: 2026-10-16
status: active
issue: ISS-0072 (major)
---

# An open Settings page keeps its Still Pro answer fresh

## Problem

On Chrome 2.1.1.370, signed in and not yet owning Still Pro, a Settings tab that was left open
without a reload went from **Get Still Pro** to "Still Pro needs to be verified again." with only
Restore purchase. It happened about ten minutes after the last reload. It also happened on return
from a cancelled checkout. A reload always fixed it. The ISS-0023 fix covers a page that is opened
or reloaded; it does not cover a page that stays open.

## Root cause (evidence)

- A signed-in "no Still Pro" answer is short-lived evidence: the background's scoped reconciler
  treats a conclusive "none" as absent for 60 s only (`account-access-transport.ts`,
  `evidenceStatus` and `evidenceDeadline`). Past that, the Still Pro rows resolve to
  `verification_required` until a fresh reconcile.
- The Settings card's host (`packages/ext-chromium/lib/browser-pro.ts`) renewed a visible "none"
  every 45 s, but at most `KEEP_ALIVE_LIMIT = 10` times for the page's whole life (about 7.5 min).
  The owner's tab was reloaded about 4:03 PM and showed "verify again" at 4:13 PM.
- Once the answer turned into "verify" for any reason, nothing re-checked it while the page stayed
  visible. `observe()` cleared the renewal timer, and the timer itself skipped anything that was
  not "none". The answer is also replaced by events in the background: every auth state change
  (including the hourly token refresh) bumps the reconciler's epoch, and a change to the stored
  access record (a sync, a checkout operation ending) makes the page observe again. After the
  cancelled checkout, the return re-check ran, and such a later change left the card on "verify".
- Showing the page again re-checked only after a 30 s spacing, and window focus did not re-check
  at all.

**Shared path.** Chrome, Firefox desktop and Firefox for Android build their Settings Still Pro card
from the same `browser-pro.ts` host and `InformationalProSettings.svelte`. Safari's web Settings
page has no Buy card (it hands off to the Still app) and draws from the ISS-0032 offer latch, so it
cannot show this. The popups also draw their card from that latch, and close on focus loss.

## Approach

All of it is in the browser Settings card's host. There is no change to the background, the access
policy or the shared Still Pro card.

1. **Renewal allowance per visit, not per page life.** `KEEP_ALIVE_LIMIT` becomes 80 (about an
   hour of 45 s renewals). It restarts whenever the page is shown again or its window is focused.
   A page left untouched for more than about an hour stops asking the server, as before.
2. **A known none that goes stale is renewed at once.** The host remembers that this account was
   last seen conclusively without Still Pro. When that answer turns into "verify again" on a visible
   page, it runs the same scoped re-check once (counted against the allowance). While it runs, the
   card shows its existing "Checking your Still Pro access…" state. "Still Pro needs to be verified
   again." shows only if that re-check does not confirm "none" (or fails). Because the page shares
   one re-check flight, the first answer may come from a check already under way when the answer
   went stale (for example a token refresh during it), so one fresh check decides before "verify
   again" (at most two checks per stale answer; found in review). There is no loop: a failed
   renewal clears the memory until a fresh "none" is seen.
3. **Focus and return.** Window focus re-checks like showing the page again (same 30 s spacing). A
   stale known none is renewed on show or focus regardless of the spacing. Return from the checkout
   tab keeps its immediate re-check.

## Verification

- Unit (`lib/__tests__/browser-pro.test.ts`, fake timers): a page visible for 20 minutes keeps
  renewing (27 renewals, past the old cap of 10); "none" turning into "verify" re-checks at once
  with `renewing` shown; a renewal that joined a stale check gets one fresh check; a failed
  renewal leaves "verify" and does not loop; past the allowance
  focus re-checks and restarts it; gone stale while hidden, showing the page re-checks inside the
  spacing; focus inside the spacing does nothing; another account is not treated as stale; `stop`
  removes the focus listener. The existing bounded-renewal test now expects the allowance to
  restart when the page is shown.
- Options page (`entrypoints/options/__tests__/browser-pro-host.test.ts`, the real options page,
  controller and card over a synthetic background): a stale access record shows "Checking your
  Still Pro access…" while it re-checks, then keeps Get Still Pro without "verify again", also when it went stale while hidden; a re-check that does not
  confirm none shows "verify again".
- Red first: run against the previous `browser-pro.ts` and `InformationalProSettings.svelte`, 9 of
  the new or changed tests failed; all pass with the fix.
- Gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm exec playwright test --project=fixtures`.

## Not covered (manual retests)

- CH-50 extended: leave Settings open 20 minutes with no reload; Get Still Pro stays.
- CH-54: return from a cancelled checkout; Get Still Pro, no "verify again".
- The Firefox equivalents (FX-43..49 group).

## Watch item checked, not filed

The Mac card that still said "verify again" about 30 s after the server verified the right: the
Apple settings screen re-reads native access at least every 60 s in paid builds (the native
snapshot's `refreshAfterMs`, `AccessProof.swift`, and `EntitlementCache`'s timer). A 30 s lag is
inside that window, so the code does not confirm a gap.
