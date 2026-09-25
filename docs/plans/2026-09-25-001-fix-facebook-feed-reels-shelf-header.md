---
title: "Hide the whole Facebook home-feed Reels shelf, not just its tiles"
status: implemented (awaiting store rebuild)
date: 2026-09-25
owner: "Claude Code"
branch: "fix/facebook-feed-reels-header"
---

# Hide the whole Facebook home-feed Reels shelf, not just its tiles

## Outcome

With Still on, the desktop Facebook home feed shows no Reels shelf at all: neither the carousel
nor its "Reels" header row with the icon and "…" button. Ordinary posts, "People you may know",
Stories and sponsored posts are unaffected.

## Evidence and root cause

The owner saw an empty "Reels" card (header only) on the signed-in home feed. Probed live on
2026-09-25 with the capture profile copy, desktop Chromium, current `main` build:

- Still off: the shelf is one feed unit. Facebook wraps every feed item in its own
  `div[data-virtualized]` (7 units, one per item; no unit contains another). Inside the shelf's
  unit: a card body with two children, a header (icon button, a visually hidden `<h3>Reels</h3>`,
  the "…" button) and the carousel, which holds `div[role="grid"][aria-label="Reels"]` with
  `role="gridcell"` tiles. Ordinary posts use `h4` headings and never contain that grid.
- Of every Facebook selector in the seed, only `fb-watch`'s `div:has(> a[href*="/reel/"])`
  matches inside the shelf, and it matches only the gridcells. Nothing matches the grid, the
  header, or any ancestor of the grid.
- Still on: tiles removed, grid still present (16 px, empty), header visible, unit 66 px tall.
  Seen on five of five loads across four sessions. A missing grid was never observed; the
  reported 66 px card height equals header plus the empty 16 px grid, so the grid was most likely
  present in the owner's capture as well.

Root cause: `main` has no rule for the shelf card at all. PR #213 proposed `fb-feed-shelf`, but its
review remediation (plan 2026-09-24-002) removed it before merge because its four-ancestor
selector could hide a whole feed, and recorded "an empty header may remain" as a deferred
limitation. So this is not rule-order dependence between shelf and tile rules; it is the absent
card rule. The fix must still be order independent, which the anchor choice below guarantees.

## Decisions

1. **Boundary: Facebook's own feed unit, not an ancestor count.** New `hide` surface
   `fb-feed-shelf`:
   `div[data-virtualized] > div:has(div[role="grid"][aria-label="Reels"]):not(:has([data-virtualized]))`.
   The unit is identified independently of the grid's depth, so a shallower or deeper carousel
   still resolves to the same card. The `:not(:has([data-virtualized]))` guard refuses any unit
   that contains another unit, so a hypothetical outer virtualized wrapper can never take the
   feed with it. A grid outside any unit (unknown markup) fails open: the header may remain.
2. **Hide the unit's child, not the unit.** The #213 lesson: Facebook measures some elements and
   reacts when they lose their box. The unit is what Facebook's virtualizer measures, so it keeps
   a laid-out zero-height box. Live: zero `data-virtualized`, attribute or child mutations on the
   unit across 360 sampled frames, a 7,200 px scroll away and back. Hiding the unit itself was also
   stable in the same probe and would drop one extra 12 px feed gap, but it relies on Facebook never
   reacting to a boxless unit; the extra 12 px is the accepted cost of not relying on that.
3. **Hide, not remove; order independence.** The anchor is the grid, which no Facebook rule
   removes (only its gridcells go), so the CSS match does not depend on the order in which the
   tile removal runs. With the packaged stylesheet it applies at style recalculation, before
   paint, with no React-owned node detached. For fetched rule sets the JS sweep computes hides
   before removals in the same pass, and the inline style persists even if Facebook later drops
   the grid. A test pins the invariant that no Facebook remove selector matches the grid or its
   ancestors.
4. **Compatibility.** `:has()` (including inside `:not()`) needs Chromium 105, Safari 15.4 and
   Firefox 121; supported Firefox is 140+. Each generated CSS rule stands alone, and the JS sweep
   falls back per selector, so an engine without `:has()` drops only this rule and the header
   remains as today. Existing Facebook rules already depend on `:has()`; the Safari 15.0 to 15.3
   gap is pre-existing and out of scope.
5. **Version and delivery.** Rule set 1.1.11, dev re-signed via `sign-seed`, Chromium and Safari
   CSS regenerated (Firefox shares the Chromium output), signing guide updated. Hide surfaces live
   in packaged CSS, so the complete fix ships with rebuilt store packages; fetched rules add the JS
   hide only.

## Work units

1. Fixture: model the recorded feed as `data-virtualized` units: the shelf (header + carousel),
   an ordinary post, "People you may know", Stories, a sponsored post, a shelf whose tiles are
   already gone, and a guard unit that wraps another unit plus an ordinary post. Keep the shallow
   grid guard. Rewrite the deferred-header test to require the whole card hidden. Confirm it fails
   on `main`.
2. Seed, signature, CSS, content-CSS and engine tests (JS sweep, order invariant, empty grid).
3. Gates, then live verification over several feed loads; update the #213 solution doc.

## Acceptance scenarios

1. The shelf header and carousel are hidden, with tiles present or already removed, and stay
   hidden when tiles are removed after load.
2. Ordinary, People-you-may-know, Stories and sponsored units stay visible; a wrapper unit that
   contains a shelf unit and a post keeps the post visible; a shallow grid never hides its feed.
3. Live: no Reels header or shelf over several loads; other posts intact; the unit does not
   flicker or virtualize-loop.

## Risks

- The boundary is Facebook's `data-virtualized` attribute, recorded on the desktop home feed on
  2026-09-25. If Facebook renames it, the rule fails open (header reappears), not closed.
- Extra 12 px gap where the shelf was (margin on a wrapper above the unit).

## Verification evidence

- Fail before: on the `main` build the two new Facebook fixture tests failed. The card stayed
  visible, and the late shelf's header was visible in 30 of 30 frames. Against `main`'s seed and
  CSS, the three new engine tests and the content-CSS assertion also failed.
- Pass after: `pnpm lint`, `pnpm typecheck`, `pnpm test` (825 core, 81 Safari and 63 Chromium
  passed; 39 skipped), `pnpm build`, `pnpm exec playwright test --project=fixtures` (92 passed,
  2 skipped).
- Cross-engine: the generated stylesheet on the fixture hid all three shelf variants and kept all
  seven controls in Chromium 153, Firefox 155 and WebKit 26.6.
- Live, signed in, rebuilt extension: 4 feed loads, 80 samples, a shelf in every load. There were 0
  samples with a visible Reels header, grid or reel link, and no match without the grid or with a
  post heading. At least 3 ordinary post units stayed visible in every sample.
- Store rebuilds and minimum-version Safari devices are not verified here.
