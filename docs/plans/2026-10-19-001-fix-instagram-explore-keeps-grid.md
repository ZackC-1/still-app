---
title: Keep Instagram's Explore grid while hiding its Reel tiles - Plan
type: fix
date: 2026-10-19
execution: code
issues: [ISS-0083, ISS-0064, ISS-0053]
status: implemented, awaiting device retest
---

# Keep Instagram's Explore grid while hiding its Reel tiles

## Problem

On iPhone Safari with the Instagram Blocker on, Explore turns from Instagram's grid into a feed of
one post per row, and each new batch seems to take 2 to 3 seconds while scrolling. With the blocker
off it is the normal grid and feels faster (ISS-0083, cases IOS-16 and IOS-33, builds .387/.392,
rule set 3.0.15). Owner expectation: Explore keeps Instagram's grid and loading speed; only the
Reel tiles are removed or neutralised.

## Cause (evidence)

- The ISS-0064 layout (`INSTAGRAM_EXPLORE_LAYOUT`) turned every Explore row holding a Reel into a
  flex line and let the remaining posts grow to fill it, capped at 75vh. On a Reel-heavy Explore
  most rows keep one post, so on a phone each of those posts becomes the full screen width.
- Measured on the paginating Explore fixture at 390x844 (WebKit and Chromium give the same boxes):
  blocker off, every post is 129px wide in 172px rows; blocker on before this fix, posts are 195px
  or 390px wide in rows 259px or 520px tall. That is the single-column feed the owner saw.
- The CSS matching cost itself is small. Appending 20 batches of 24 tiles with style and layout
  forced after each batch costs about 5ms a batch in WebKit with the blocker off and about 10ms with
  it on (17ms by batch 20). That is milliseconds, not seconds, so selector cost does not explain
  the reported wait. The content script's per-frame work is already coalesced to one pass per
  animation frame and does not scan the grid.
- Not established: why each batch felt 2 to 3 seconds slower on the device. Plausible results of the
  widening are larger image requests for full-width posts and rows up to three times taller than
  Instagram's own estimates. Only a device profile can confirm this.

## Change

- `INSTAGRAM_EXPLORE_LAYOUT` keeps only `min-height:1px` on a row holding a Reel, so a row of only
  Reels stays measurable (ISS-0053). Every row keeps Instagram's display, columns and tile size.
  Remaining posts close up from the start of their row. The space a Reel leaves is at the row's end.
- The rule data and its signature do not change (3.0.15 stays), so there is no remote-rule
  compatibility step.
- `docs/PRODUCT.md` states the new Explore promise. The solution note records the trade-off.

## Tests (red before, green after)

- Unit (`instagram-format2.test.ts`): with Instagram's grid styles present, every row and remaining
  post keeps its computed layout (display, grid columns, flex, width, max-height, overflow). Only
  a Reel row's minimum height changes.
- Chromium fixtures (`fixtures-format2.spec.ts`, 1280px and 390px): every row keeps the untouched
  page's display and columns, and each post keeps one cell's width and takes the row's next cell.
  The paginating model requires every post at Instagram's cell width and no blank band across the
  column. Before the fix these failed: the rows were flex, and a 390px post was 261px wider than its cell.
- Real Firefox lane: the same grid checks.

## Retest

IOS-16 and IOS-33 on a physical iPhone: Explore must look like Instagram's grid with no Reel tiles.
Scroll for 30 seconds with the blocker on, then off, and compare how long each batch takes. If it is
still slower with the blocker on, take a Safari Web Inspector timeline (Layout and Rendering,
Network) of one batch with each setting.
