---
title: Preserve site-owned Reel aliases and measured Explore rows
category: ui-bugs
track: bug
problem_type: integration_error
module: packages/core
applies_when: Blocking rewrites a single-item viewer address or changes the geometry of a measured discovery grid
date: 2026-10-14
status: active
tags: [instagram, navigation, aliases, virtualization, explore]
---

## Recognize the boundary

An extension can create a redirect loop by rewriting `/reels/<id>/` to `/reel/<id>/`
while the site chooses the plural spelling. Both URLs identify one deliberately opened clip.
Forcing one spelling is unnecessary for stopping continuation to a different clip.

Explore has a separate ownership boundary: its rows and tile boxes supply geometry to the site.
Hiding individual cells and flattening rows with `display:contents` changes that geometry.
A fixed-track row can retain holes, while flattening removes the row box that a virtualizer measures.
The local regression proves these layout changes; it does not establish the cause of every live loader failure.

## Repair

In `packages/core/src/rules/engine.ts`, accept both single-item aliases and compare Reel identity
when deciding continuation. Keep the bare Reels feed redirect and profile-tab behavior.
In `navigation-dnr.ts`, remove the plural-to-singular rewrite too: fixing only the content engine
leaves the network rule able to loop. The viewer allow rule retains its ID and takes priority over
the profile-tab fallback, including the ambiguous `/reels/reels/` address.

Removing a redirect changes startup classification. `modern-shipping-entry.ts` must still evaluate
a plural viewer that advances during settings hydration. Reuse the existing route candidate filter
and page-session continuation logic; the first clip needs no pending redirect cover.

For Explore, the accepted behavior keeps discovery thumbnails and contains different-ID continuation
in the viewer. Remove the Explore-only tile hide, layout rules and marker together, then regenerate
the packaged signed rules and free-surface pin. Profile and Home rules remain separate.
Do not invent replacement wrappers or hide every video to recover the old appearance.

## Verification and limits

- `format2-navigation.test.ts` covers same-ID singular/plural and bare/www aliases, share context,
  and different-ID continuation. `modern-shipping-entry.test.ts` covers delayed hydration and Off.
- `navigation-dnr.spec.ts` exercises the built extension against controlled site canonicalization.
  The baseline repeats the singular request; the repair reaches the plural player and still
  sends a subsequent different-ID navigation Home. This is a synthetic route transition,
  not a recorded Instagram server or login redirect chain.
- `instagram-format2.test.ts` and `fixtures-format2.spec.ts` use the captured Explore structure.
  Browser checks compare On/Off boxes, insert later mixed rows, scroll to a sentinel and add
  nonzero virtualized padding. The baseline changes the boxes; the repair preserves them.
  The 390px case adds explicit responsive test CSS to the desktop capture and is not mobile DOM evidence.
- The focused rules/content suite passed 1,169 tests; the affected Chromium browser specs passed
  118 tests with one configured-lane skip. Isolated Firefox and WebKit rendering also preserved
  geometry at desktop and phone widths. These checks do not establish authenticated live pagination
  or installed iPhone Safari behavior; those need successor-package retests.

## Prevention

Treat URL spelling, item identity and feed continuation as separate decisions. Check both network
and content routing whenever a redirect changes. Test startup handover as well as navigation
after hydration. Before changing a measured grid, compare boxes with blocking Off and On, including
later batches and virtualized padding; visibility alone cannot prove layout preservation.

Related: [preserve page state during navigation classification](../logic-errors/preserve-page-state-when-classifying-navigation.md),
[identify a feed card by its item wrapper](identify-a-feed-card-by-the-sites-item-wrapper.md),
and [preserve measured tab boxes](hiding-a-measured-tab-with-display-none-flickers.md).
