---
title: Hide Instagram Explore Reel tiles without stalls or holes - Plan
type: fix
date: 2026-10-15
execution: code
issues: [ISS-0064, ISS-0053]
---

# Hide Instagram Explore Reel tiles without stalls or holes

## Problem

With Instagram blocking On, Explore shows Reel tiles (play icon) on iPhone Safari and Safari Mac
(ISS-0064; the rule is shared by every surface). `docs/PRODUCT.md` promises that Explore's Reel
tiles leave the grid without holes. The owner decided on 15 Oct to hide them again, "in a way that
doesn't cause stalls or holes". The ISS-0053 result must keep passing: Explore loads continuously,
with no holes and no stalled spinner, and the post viewer keeps containing Reel continuation.

## Root cause (evidence)

- `fad1f237` removed the Explore tile hide, its layout and its address mark as the ISS-0053 fix.
  That removed the symptom by removing the feature.
- The removed layout (`b8d930f9`) joined the rows into one grid by giving every row
  `display:contents`, and switched itself off while the column carried virtualized padding.
  A `display:contents` row has no box: a virtual list cannot measure it, and a ResizeObserver
  never reports it, so the list keeps estimating heights that do not match what is drawn. When
  the padding turned non-zero the layout dropped out, so hidden tiles left holes at row ends.
- Owner evidence matches both halves: Firefox showed three posts and a loader that never resolved
  (rows flattened); the iPhone showed holes and very slow loading (padding non-zero, rows restored).
- Instagram's loader and virtual list are not observable here (no live capture). The repair
  therefore holds the invariants any measured virtual list and either loader shape relies on.

## Approach

Keep every Explore row a real, measurable box, and change only rows that hold a Reel tile:

1. Restore the address-scoped Explore mark (`INSTAGRAM_EXPLORE_MARKER`): the Explore hub, kept
   while a tile is open in the post viewer over it.
2. Rule data hides Explore Reel tile boxes (`display:none`), as before (a Reel tile is told by its
   looping video or its Reel/Clip badge).
3. Packaged layout, for a row that holds a Reel tile only: the row becomes a flex box in which
   the remaining tiles share each line's width equally (no hole at a line's end). A row that states
   its column count wraps at that many tiles a line, so a row with more tiles than columns is never
   squeezed into one line. A row whose tiles are all Reels keeps a 1px box, so it is never a 0x0
   box a ResizeObserver cannot report.
   A widened tile is capped at 75% of the viewport height so one post cannot fill a desktop screen.
4. No `display:contents`, no column-level rewrite, and no switching off under virtualized padding.
   Rows without a Reel keep Instagram's own grid. Rows a widened tile makes taller are measured as
   they are; widened tiles make rows taller, not shorter, so the loader keeps arriving.

Rejected: flattening rows (ISS-0053 mechanism); per-row hide without layout (holes); keeping
Reel cells as blank placeholders (holes); intercepting Instagram's data (needs live captures and a
main-world script); sizing rows from a hard-coded tile aspect (unverified).

## Tests first (must fail on current main)

- `tests/fixtures/instagram-explore-feed.html`: the captured Explore structure driven by a
  synthetic measured virtual list (ResizeObserver heights, estimates for unmeasured rows, padding
  for unmounted rows) and a synthetic loader (`?loader=io` IntersectionObserver that reports only
  changes, or `?loader=scroll`). Mixed photo/carousel/Reel pages, including all-Reel rows.
- Chromium format-2 fixtures at 1280px and 390px (iPhone viewport): Reel tiles absent, every
  mounted row measured, no blank band in the viewport, pagination reaches every page with both
  loader shapes, live Off restores Instagram's rows and On hides again.
- Real Firefox lane (`tests/firefox`): the same pagination, holes and On/Off checks on the built
  Firefox extension.
- Unit (`instagram-format2.test.ts`): Reel tiles hidden only under the mark; rows stay boxes;
  marker ownership by address; hide/layout selector coupling.
- Viewer containment: the existing format-2 viewer cases keep passing.

## Retest

IOS-16, FX-17, CH-17, MAC-17. Physical iPhone Safari and Firefox desktop first, with live
pagination: scroll Explore for at least 30 seconds, then compare Instagram Off and On.

## Risks

- Instagram's iPhone DOM was never captured. The selectors are the ones that matched there in
  .351 (the hide left holes there, so it matched), but the iPhone grid may use tall tiles; if its
  rows differ, the retest will show it and a structure-only capture is needed.
- Widened tiles change Explore's look (wider or larger posts in rows that had Reels).
- `:has()` cost on iPhone Safari is bounded by the Explore mark, as for the profile grid.
- Packaged format-2 version bump; remote rule sets need clients with the same layout (ARCHITECTURE).
