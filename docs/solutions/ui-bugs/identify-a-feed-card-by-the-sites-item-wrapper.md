---
title: Identify a feed card by the site's own item wrapper, and anchor on what no rule removes
category: ui-bugs
track: bug
problem_type: integration_error
module: packages/core/rules
applies_when: Tile rules empty a shelf or carousel but its header or card stays behind, or a card rule needs a boundary that will not grow into the whole feed
date: 2026-09-25
status: active
tags: [facebook, selectors, feed, shelf, has, virtualization, rule-order]
---

## Symptom

With Still on, Facebook's home feed showed an empty "Reels" card: the header row (icon, "Reels",
"…") with nothing under it. Every tile was gone.

## Cause

Not rule order. `main` had no rule for the card at all. `fb-watch` removes each tile
(`div:has(> a[href*="/reel/"])` matches the gridcells), and the card rule proposed in PR #213 was
dropped in review because it counted four ancestors up from the grid, which can select the whole
feed when a wrapper disappears. Live probes showed the grid itself survives, empty and 16 px tall,
so a card that stays at header plus 16 px is a sign the grid is still there.

How to tell the cases apart quickly: match every rule selector for the service against the Still
off DOM and record which elements inside the card each one hits. Here only the gridcells matched.
No rule touched the header, the grid, or any ancestor of the grid.

## Fix

`fb-feed-shelf` (rule set 1.1.11) hides
`div[data-virtualized] > div:has(div[role="grid"][aria-label="Reels"]):not(:has([data-virtualized]))`.

- **Boundary from the site, not from a count.** Facebook wraps every feed item in its own
  `div[data-virtualized]` unit. None of the units recorded live contained another. Selecting the
  unit's child that contains the carousel resolves to the same card however deep the grid sits.
  `:not(:has([data-virtualized]))` refuses a wrapper that contains another unit. `:has()` cannot be
  nested inside `:has()`, but it is valid inside `:not()`.
- **Anchor on something no rule removes.** The grid survives tile removal, so the CSS match does
  not depend on whether the tile sweep has run. A unit test pins it: no Facebook `remove` selector
  may match the grid or any ancestor of it. A `:has()` anchor on the tiles themselves would lose
  its match once the tiles are removed.
- **Hide the measured wrapper's child.** Same lesson as the flickering Page tab: the unit is what
  Facebook's virtualizer measures, so it keeps a zero-height box. Across 360 sampled frames and a
  7,200 px scroll away and back, the unit showed zero attribute or child mutations. The cost is one
  extra 12 px feed gap, from a margin on a wrapper above the unit.
- **Hide, not remove.** Packaged CSS applies before paint and detaches no React-owned node. With
  fetched rules, the JS sweep matches hides before it removes anything in the same pass, and the
  inline style it sets stays in place.

## Verification

- Fixture units recorded on 2026-09-25 cover the shelf, an already emptied shelf and a nested
  unit, plus ordinary, sponsored, Stories and People-you-may-know units. A shelf inserted after load
  is sampled for 30 frames while its tiles are removed. Both Playwright tests and three engine
  tests failed on `main` and pass with the rule. The generated CSS was also checked in Chromium,
  Firefox and WebKit.
- Live, signed in, rebuilt extension: 4 feed loads, 80 samples, a shelf in every load. There were
  0 samples with a visible Reels header, grid or reel link. Every matched element contained the
  grid and none contained a post heading. At least 3 ordinary post units stayed visible in every
  sample.

## Prevention

Before writing a card or shelf rule, find the site's own per-item wrapper (virtualization unit,
list item, pagelet) and bound the rule by it. Check which existing rules delete nodes inside the
card, and anchor on a node none of them deletes. Unknown markup should fail open.

Related: `docs/solutions/ui-bugs/hiding-a-measured-tab-with-display-none-flickers.md`,
`docs/plans/2026-09-25-001-fix-facebook-feed-reels-shelf-header.md`.
