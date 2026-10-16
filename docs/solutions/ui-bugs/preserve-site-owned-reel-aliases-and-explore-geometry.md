---
title: Preserve site-owned Reel aliases and keep Explore rows measurable
category: ui-bugs
track: bug
problem_type: integration_error
module: packages/core
applies_when: Blocking rewrites a single-item viewer address or changes the geometry of a measured discovery grid
date: 2026-10-14
updated: 2026-10-15
status: active
tags: [instagram, navigation, aliases, virtualization, explore, resizeobserver]
---

## Recognize the boundary

An extension can create a redirect loop by rewriting `/reels/<id>/` to `/reel/<id>/`
while the site chooses the plural spelling. Both URLs identify one deliberately opened clip.
Forcing one spelling is unnecessary for stopping continuation to a different clip.

Explore has a separate ownership boundary: Instagram virtualizes its column. It draws only the
rows near the viewport, measures them, and stands in for the rest with the column's inline padding.
Layout changes inside that column must keep every row a box the list can measure.
`display:contents` removes the row's box, so the list keeps an estimate that no longer matches
what is drawn. A row that has always been 0x0 is never reported by a ResizeObserver, so it fails
the same way. Switching a layout off when the padding turns non-zero brings holes back mid-scroll.
Those were the two halves of ISS-0053 (a stalled loader on Firefox; holes and slow loading on iPhone).

## Repair

In `packages/core/src/rules/engine.ts`, accept both single-item aliases and compare Reel identity
when deciding continuation. Keep the bare Reels feed redirect and profile-tab behavior.
In `navigation-dnr.ts`, remove the plural-to-singular rewrite too: fixing only the content engine
leaves the network rule able to loop. The viewer allow rule retains its ID and takes priority over
the profile-tab fallback, including the ambiguous `/reels/reels/` address.

Removing a redirect changes startup classification. `modern-shipping-entry.ts` must still evaluate
a plural viewer that advances during settings hydration. Reuse the existing route candidate filter
and page-session continuation logic; the first clip needs no pending redirect cover.

For Explore (ISS-0064, owner decision 15 Oct: hide the Reel tiles without stalls or holes),
`packages/core/src/rules/instagram.ts` restores the address-scoped Explore mark and the Reel tile
hide (rule data, `display:none`). It adds a packaged layout that changes only a row holding a Reel.
That row becomes a flex box, and the remaining posts share each line's width, so no line has an end
hole. A row that states its column count (`repeat(N,`) wraps at N posts a line; a row holding more
tiles than columns is therefore never squeezed into one line. A row of only Reels keeps a 1px box,
and a widened post is capped at 75vh. There is no `display:contents`, no column rewrite, and no
padding-dependent switch. Rows without a Reel keep Instagram's grid. Widened posts make rows
taller rather than shorter, so the content stays long enough for the loader to keep arriving. Do not
reintroduce a row-flattening or cross-row reflow: it makes rows unmeasurable. Re-sign the
packaged rules and update the free-surface pin with any selector change.

## Verification and limits

- `format2-navigation.test.ts` covers same-ID singular/plural and bare/www aliases, share context,
  and different-ID continuation. `modern-shipping-entry.test.ts` covers delayed hydration and Off.
- `navigation-dnr.spec.ts` exercises the built extension against controlled site canonicalization.
  The baseline repeats the singular request; the repair reaches the plural player and still
  sends a subsequent different-ID navigation Home. This is a synthetic route transition,
  not a recorded Instagram server or login redirect chain.
- `tests/fixtures/instagram-explore-feed.html` drives the captured Explore structure with a
  synthetic measured virtual list: ResizeObserver heights, estimates for unmeasured rows, and
  padding for unmounted rows. Its loader is an IntersectionObserver that reports only changes, or
  a scroll listener. Pages mix photos, carousels and Reels, including rows of only Reels.
  Neither the list nor the loader is Instagram's code.
- `fixtures-format2.spec.ts` (Chromium, 1280px and 390px, both loaders) and `tests/firefox`
  (real Firefox, both loaders, plus a 390px viewport) scroll to the last page. Every step requires
  no Reel shown, no 0x0 or unmeasured row, and no blank band over 8px. Live Off restores
  Instagram's grid (in Chromium, the exact boxes of an untouched page), and On hides it again. The captured static fixture checks edge-to-edge rows,
  including under non-zero virtualized padding. The viewer cases still send a Reel's Next Home.
- These tests failed before the repair: Reel tiles were drawn. In an isolated run of the model, the
  old flattening layout stalled the scroll loader on page 1 at 390px and left rows unmeasured.
  The repaired layout's CSS also passed the model in an isolated WebKit run.
- Not established by these checks: Instagram's iPhone DOM (only the desktop structure was
  captured; the iPhone grid shows tall tiles, and the tall-tile row in the static test is a
  hypothetical shape), Instagram's real loader, and installed-package behavior on devices. Live
  pagination on physical devices is the deciding check. If the iPhone grid's nesting differs, the
  hide does not match and Reels stay (no holes).
- Reel tiles are recognized by a looping video or an English Reel/Clip badge. A tile whose video
  is added late in another language is hidden only once the video appears.

## Prevention

Treat URL spelling, item identity and feed continuation as separate decisions. Check both network
and content routing whenever a redirect changes. Test startup handover as well as navigation
after hydration. Before changing a virtualized grid, keep every row a measurable, non-zero box,
and test later pages through a measured list with both loader shapes: visibility alone proves
nothing about loading.

Related: [preserve page state during navigation classification](../logic-errors/preserve-page-state-when-classifying-navigation.md),
[identify a feed card by its item wrapper](identify-a-feed-card-by-the-sites-item-wrapper.md),
and [preserve measured tab boxes](hiding-a-measured-tab-with-display-none-flickers.md).
