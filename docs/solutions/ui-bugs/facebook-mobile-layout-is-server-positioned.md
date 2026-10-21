---
title: Facebook's mobile layout is server-positioned; hide a tab by its tap target and a Home feed section by its whole row
category: ui-bugs
track: bug
problem_type: integration_error
module: packages/core/rules
applies_when: A Facebook Reels surface stays visible on iPhone Safari (or any phone browser) while the same surface is hidden on desktop, or a rule for Facebook's mobile layout needs a boundary
date: 2026-10-15
last_updated: 2026-10-21
status: active
tags: [facebook, mobile, safari-ios, selectors, tabs, capture, feed]
---

## Symptom

ISS-0035 on a physical iPhone in Safari (2.1.1.361, Facebook Blocker on): a brand Page showed the
tabs All / Photos / Reels / Mentions and the Reels tab opened the Page's Reel grid. Safari on the
Mac hid the desktop Page tab and passed. The Home feed also showed a "Reels" section (see
"The mobile Home feed").

## Cause

The mobile rule `[role="tab"][aria-label^="Reels," i] > *` was written for an older mobile tab bar
whose labels read `Reels, 4 of 6`. A Page's tab row in the current mobile layout is different:

- `div[role="tablist"] > div[role="tablist"] >` one **outer** `div[role="tab"]` per tab (the tap
  target, with `data-action-id` except on the selected tab) `> div >` an **inner**
  `div[role="tab"]` whose `aria-label` is exactly `Reels` (or `All`, `Photos`, `Mentions`).
- The label has no comma, so nothing matched.

## How the structure was obtained without an account

The mobile layout is served to an iPhone user agent signed out as well. Playwright WebKit with the
`iPhone 15 Pro` device profile at `m.facebook.com/<page>/` (and `www.facebook.com/<page>/`) drew the
same tab row as the owner's signed-in screenshot. Tapping the tab moved to `/<page>/reels/`. Record
only roles, interface labels, inline sizes and `data-*` attribute names, never page content. The
Home feed needs a signed-in account, so it cannot be captured this way.

## Fix

Hide the outer tab, unless it is the first in its row:
`[role="tablist"] > [role="tab"] ~ [role="tab"]:has(> * > [role="tab"][aria-label="Reels"])`.

- **Not just the label.** Hiding the inner tab or the outer tab's children leaves the outer tab's
  box in place, invisible but still tappable, and the tap still opens the Reel grid.
- **`display:none` is safe here, unlike desktop.** The mobile layout is computed by the server: each
  tab has a fixed inline width and `margin-left`, and each tab after the first is pulled back up with
  `margin-top:-46px`. Hiding a tab on the live signed-out pages caused no attribute or child
  mutation in the row over 3 seconds, so Facebook does not appear to re-measure it, and the
  remaining tabs stayed where they were. (The fixture's zero-mutation check has no Facebook script;
  it only proves Still writes nothing into the row.) The cost was a blank slot where Reels was; the inline
  offsets cannot be rewritten, but the neighbours can be slid (see "The top tab bar").
- **Never the first tab.** Every later tab is pulled up against the one before it, so hiding the
  first tab would slide the whole row out of its clipped box. `~` limits the rule to tabs after
  the first; a row that starts with Reels fails open. Compare the desktop row, which measures its tabs and must have
  only their contents hidden ([hiding-a-measured-tab-with-display-none-flickers](hiding-a-measured-tab-with-display-none-flickers.md)).
- Unknown nesting fails open: if the wrapper depth changes, nothing matches.

## The mobile Home feed

It needs a signed-in account, so it was captured on the owner's iPhone through Safari Web
Inspector with the sanitizing snippet in `docs/plans/2026-10-15-002-fix-facebook-mobile-reels.md`
(16 Oct 2026). Do not model it from the signed-out Watch shelf.

- The feed is `div[data-type="vscroller"]`; on the Home feed each unit (a post, the Reels section)
  is **one** direct child row, separated by 1 px divider rows. A Page timeline is different: a post
  there is several sibling rows with no wrapper, so a row rule must not assume Page structure.
- The Reels section row holds a header three wrappers down (icon, `h2` "Reels", "See more" button)
  and reel cards, each `role="button"` labelled `View reel video …`.
- Rows compute to `position: static`/`relative` and stack with `margin-top` (checked signed out
  on Watch and two Pages), so `display:none` on a row closes the gap; nothing is re-measured.

Rule: `[data-type="vscroller"] > :has(> * > * > * > h2):has([role="button"][aria-label^="View reel"])`.
Requiring the header at that depth keeps a single shared reel (no header) and other headed
carousels (no reel cards) visible; a changed depth or label fails open.

## Verification

- `tests/fixtures/facebook-mobile-home.html` models the captured Home feed rows. The core tests
  (section hides on `m.` and `www.`, after infinite scroll, and lookalikes stay) failed 4 of 4
  before the rule; the extension test checks the post below moves up under the dividers and live
  Off/On.

- `tests/fixtures/facebook-mobile-page.html` models the captured row with its inline geometry.
- `facebook-format2.test.ts`: the outer tab hides on the Page, on its `/reels/` address and in the
  selected state captured there; the other tabs and an ordinary video post stay, keep their HTML,
  and Off restores the tab; lookalike labels, a loose Reels label outside a tab row and a
  Reels-first row stay. Four cases failed before the rule; the Reels-first case fails without `~`.
- `fixtures-format2.spec.ts` (Chromium extension): the tab hides, the other tabs keep their left
  edges (0, 73, 271), their top and height inside the row, Still writes nothing into the row, and
  live Off/On restores then hides it. It failed before the rule.
- The full packaged Facebook selector list matched exactly one element (the tab) on five captured
  signed-out mobile Pages and profiles (one in its `/reels/` state), and nothing on the signed-out mobile Watch page.

## Prevention

- When a Facebook surface fails only on a phone, capture the mobile layout (signed out where it is
  served) before changing selectors; do not reuse desktop structure.
- Hide a mobile tab by its tap target, not its label; hide a Home feed section by its whole
  vscroller row.
- For signed-in mobile surfaces, ask the owner for a sanitized Web Inspector capture rather than
  guessing; one paste was enough here.
- Interface labels are matched in English, as on desktop; other languages fail open.

## The top tab bar (ISS-0102, 20-21 Oct 2026)

The phone Home's top bar is a `[role="tablist"]` of six `[role="tab"]` divs labelled `feed, 1 of 6`
(live: `feed, 1,755 new, 1 of 6`), `friends, 2 of 6`, `messages, 3 of 6`, `reels, 100 new, 4 of 6`,
`notifications, 5 of 6`, `marketplace, 6 of 6`, each with an inline width (one sixth of the bar) and
`margin-left`, stacked in a column and pulled up with `margin-top:-50px`; no links. The
Reels tab's contents are hidden (issue #58), so it kept a 65 px empty slot and its share of the line
under the bar was missing. `display:none` or `width:0` on the tab moves nothing, because the others
are placed by their own margins.

The first packaged layout (2.1.1.420) made the tab `visibility:hidden; pointer-events:none` and slid
the tabs before it `translateX(50%)` and the tabs after it `translateX(-50%)`. That closed the slot,
but the owner's retest (21 Oct) showed a grey band about half a tab wide at each end of the bar:
the five tabs keep a sixth of the width each, so they span five sixths of the bar. A transform
never moves the layout, and scaling the tabs (`scaleX(1.2)`, tried and dropped) draws every icon
20 % wide and leaves hairline seams between fractional-width neighbours.

### What the tab is made of (live capture, 21 Oct)

Captured read-only on the signed-in phone Home (Chromium, iPhone user agent, 390 px; roles, `data-*`
names, nesting, inline geometry and computed colours only):

- The tab list is transparent. The grey beside the tabs is the page's own background (an
  ancestor's `::before`, rgb(188,192,196)), so making the bar transparent changes nothing and
  painting it needs a colour that depends on the theme.
- Each tab paints its white box with a `::before` that fills it and holds four layers, each as wide
  as the tab (inline `width:65px`) and stacked with negative `margin-top`: the icon layer (a 29 px
  icon box at `margin-left:18px`, the icon-font glyph centred in it by flex), the 2 px line under
  the bar (a layer whose `::before` paints rgb(201,204,209)), and two badge layers (a 26 px pill at
  `margin-left:31px`/`32px`). The selected tab only colours its icon; there is no separate active
  underline.

### The fix: widen the boxes, not the contents

`FACEBOOK_REELS_LAYOUT` (code, not rule data) has two scopes:

- **Any tab list holding the `feed, …` tab:** the Reels tab is `visibility:hidden;
  pointer-events:none` (a tappable blank slot opens Reels, ISS-0035), and its neighbours slide half
  a tab towards it. This needs only equal neighbours, so a bar with an extra entry (five or seven
  tabs) still has no empty or tappable slot, only the bands.
- **That list with a Reels tab and exactly six children, all tabs:** each remaining tab gets
  `transform:none; width:20%; margin-left:<place × 20>%` (percentages of the bar; the place is the
  slot number minus one before Reels, minus two after it, so it works whichever slot Reels holds),
  and each of its layers gets `width:100%; padding-left:calc(100% / 12)`. The padding is half the
  difference between the new and old tab (1/5 − 1/6 of the bar, halved, is a twelfth of the new
  tab), so the fixed-offset icon and badges keep their size and land centred, while the layers'
  `::before` backgrounds and the line fill the whole tab. These selectors are more specific than
  the slide's and come later, so they replace it.

Measured with this CSS injected on the live page (no extension): tabs at 0–78, 78–156, 156–234,
234–312 and 312–390 px; every glyph still 28.81 × 28 px with its centre 0.56 px from the tab's
centre, as before; badge-to-icon offset unchanged (13.34 px); each line layer spans its tab; a
point 2 px inside either end of the bar hits a tab. On the fixture at 390, 393, 402 and 430 px
(device pixel ratio 3), the white row above the icons and the line row have no off-colour pixel.

Rejected fallback: keep the slide and draw a full-width 1 px line on the bar (an inset shadow).
The bands stay (they are the page's grey), and the slid tabs show faint seams. Depends on Facebook
keeping its layers as wide as the tab with contents placed from their left edge; if it changes,
the icons drift off centre by about 6.5 px rather than disappearing. Not checked: a right-to-left
locale that keeps the word "Reels" (DOM order would be mirrored, so tabs would land in the wrong
fifths).

## The Stories tray (ISS-0101, 20 Oct 2026)

On the phone Home feed the tray is one vscroller row: a horizontal scroller
(`[data-is-h-scrollable]`) four levels down whose cards are `[role="button"]`s labelled
`Create story` (the person's own, first) and `View <name> story. N new story` (or `stories`). No
main region, no `[data-virtualized]`, no `/stories/` links, so the desktop rule could not match.
The Stories extra now also hides that row, told by the scroller at that depth and those labels,
never a row holding a heading, an article, a Reel link or a `View reel video` button (the Reels
section is the free control's). Rows stack with margins, so hiding the row closes its gap.
