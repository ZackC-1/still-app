---
title: Anchor Reels entry points on the feed's address, and route the feed entry, not only the feed
category: ui-bugs
track: bug
problem_type: integration_error
module: packages/core/rules
applies_when: A site's Reels or Shorts menu entry is visible again with Still on, or a menu entry opens the short-form player although typed feed addresses already redirect
date: 2026-10-12
status: active
tags: [facebook, selectors, navigation, reels, spa, routes, dnr]
---

## Symptom

ISS-0035 (Chrome, signed in to Facebook, Still on): the left sidebar listed "Reels" and the
top-menu Reels tab opened the full Reels player at `facebook.com/reel/<id>`. Typed
`facebook.com/reels` and `/watch/reels` still went Home, and moving to the next Reel still went
Home, so the gap looked like a single missing selector. It was two gaps.

## Cause

1. **Markup drift.** Facebook's top menu and left sidebar are `div[role="navigation"]` lists, not
   `<nav>`, and the sidebar link has no label. The core rules keyed on `nav a[aria-label="Reels"]`,
   which matched neither.
2. **An unrouted feed entry.** Both menu entries point at `/reel/?s=tab`. Clicking pushes that
   address, then Facebook replaces it with `/reel/<digits>`, the first Reel of the feed. Only
   `/reels` and `/watch/reels` were routed, and `/reel/<digits>` is the shared single Reel that the
   product keeps playable, so the hand-over looked like a deliberate shared Reel.

A read-only capture of the signed-in page (roles, labels, addresses only) showed both in minutes:
the sidebar `li` holding `https://www.facebook.com/reel/?s=tab`, and a Navigation API log of
`push /reel/?s=tab` followed by `replace /reel/<id>`. The Reels player's own "For you",
"Following" and "Profile" links are `/reel/?bss=…`, `/reel/following/` and `/reel/profile/`.

## Fix

- Hide by **address**, not by label or landmark: any link to the Reels feed (`/reel/` with no id,
  `/reel/following`, `/reel/profile`, `/reels`, `/watch/reels`), relative or absolute on www. and
  m., plus the leaf `li` around it inside `nav` or `[role="navigation"]`
  (`li:has(<link>):not(:has(li))`) so the other entries close up. The shared Reel is always
  `/reel/<digits>`, which no prefix in the list reaches.
- Route the **feed entry** in the free core (`engine.ts`), the Chromium session rule
  (`navigation-dnr.ts`, id 22) and the early document_start filter (`mayBeCoreRoute`). The link
  click hook and Navigation API hook consume the click before Facebook's router runs.
- The feed entry handing over to its first Reel counts as the feed continuing
  (`reelContinuation`), for the case where Still did not get to send the entry home first.

## Prevention

- When a menu entry reappears, match the full rule set against the live DOM read-only and look at
  where the entry points before writing a selector. An address is more stable than a label or a
  landmark element.
- Every short-form feed has an entry address as well as a feed address. Route both, and keep the
  shared single item (`/reel/<digits>`, `/reel/<code>/`, `/shorts/<id>` to `/watch`) outside every
  pattern.
- Tests: `tests/fixtures/facebook-nav.html` models the current markup; the format-2 Playwright test
  clicks a forced-visible tab that mimics Facebook's push-then-replace router and asserts Home.

## Related

- [identify-a-feed-card-by-the-sites-item-wrapper](identify-a-feed-card-by-the-sites-item-wrapper.md)
- [hiding-a-measured-tab-with-display-none-flickers](hiding-a-measured-tab-with-display-none-flickers.md)
- `docs/PRODUCT.md` (single shared Reel stays playable)
