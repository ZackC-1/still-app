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

- Hide by **address**, not by label or landmark: links to exactly the addresses the core routes
  home (`/reel/`, `/reel/following/`, `/reel/profile/`, `/reels/`, `/watch/reels/`, each with or
  without a query), relative or absolute on any Facebook host, plus the leaf `li` around them
  inside `nav` or `[role="navigation"]` (`li:has(<link>):not(:has(li))`) so the other entries close
  up. Keep the hidden set no wider than the routed set; the shared Reel `/reel/<digits>` is in
  neither.
- Route the **feed entry** in the free core (`engine.ts`), the Chromium session rule
  (`navigation-dnr.ts`, id 22) and the early document_start filter (`mayBeCoreRoute`). The link
  click hook and Navigation API hook consume the click before Facebook's router runs.
- The feed entry handing over to its first Reel counts as the feed continuing
  (`reelContinuation`). When the page is already Home, Still consumes the push but issues no
  redirect, so the consumed route is remembered for the deliberate-link window and the following
  page-driven replace to `/reel/<id>` is judged from it (`content/index.ts`).
- Residual: without the Navigation API, a page-driven push and replace inside one URL-poll tick
  is invisible; a real click is still caught by the capture-phase link hook.

## Follow-up: the server hop (ISS-0039, Firefox)

Typed `facebook.com/reels` and `/watch/reels` played a Reel on Firefox while Chrome went Home.
A same-origin `fetch(path, {redirect: "manual"})` from a signed-in page showed why: Facebook's
server answers both with a redirect to `/reel/`, and that page's script replaces the address with
`/reel/<id>` almost at once. Chrome's session rule catches `/reels` before the server answers.
Firefox and Safari rely on the document_start content redirect, which rereads the address after
its settings read and found a single Reel. Fix: the early redirect also remembers the address the
document loaded at, and a hand-over from that loaded feed into one Reel is still sent Home
(`earlyFormat2CoreRedirect`, `loadedHref`). The Firefox build keeps no declarativeNetRequest
permission; the content path is its authority. The Firefox lane's router can now answer with a
302 to model the hop.

## Prevention

- When a menu entry reappears, match the full rule set against the live DOM read-only and look at
  where the entry points before writing a selector. An address is more stable than a label or a
  landmark element.
- Every short-form feed has an entry address as well as a feed address. Route both, and keep the
  shared single item (`/reel/<digits>`, `/reel/<code>/`, `/shorts/<id>` to `/watch`) outside every
  pattern.
- When a typed feed address behaves differently between browsers, check whether the site's server
  redirects it (`fetch(..., {redirect: "manual"})` gives `opaqueredirect`) before blaming rules.
- Tests: `tests/fixtures/facebook-nav.html` models the current markup; the format-2 Playwright test
  clicks a forced-visible tab that mimics Facebook's push-then-replace router and asserts Home.

## Related

- [identify-a-feed-card-by-the-sites-item-wrapper](identify-a-feed-card-by-the-sites-item-wrapper.md)
- [hiding-a-measured-tab-with-display-none-flickers](hiding-a-measured-tab-with-display-none-flickers.md)
- `docs/PRODUCT.md` (single shared Reel stays playable)
