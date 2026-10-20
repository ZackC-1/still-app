---
title: Facebook's mobile layout is server-positioned; hide a tab by its tap target and a Home feed section by its whole row
category: ui-bugs
track: bug
problem_type: integration_error
module: packages/core/rules
applies_when: A Facebook Reels surface stays visible on iPhone Safari (or any phone browser) while the same surface is hidden on desktop, or a rule for Facebook's mobile layout needs a boundary
date: 2026-10-15
last_updated: 2026-10-20
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

## The top tab bar (ISS-0102, 20 Oct 2026)

The phone Home's top bar is a `[role="tablist"]` of six `[role="tab"]` divs labelled `Home, 1 of 6` …
`Reels, 4 of 6`, each with an inline width (one sixth of the bar) and `margin-left`; no links. The
Reels tab's contents are hidden (issue #58), so it kept a 65 px empty slot and its share of the line
under the bar was missing. `display:none` or `width:0` on the tab moves nothing, because the others
are placed by their own margins. The packaged layout (`FACEBOOK_REELS_LAYOUT`, code, not rule data)
makes the tab `visibility:hidden; pointer-events:none` and slides the tabs before it
`translateX(50%)` and the tabs after it `translateX(-50%)`: half a slot each way, so the five
remaining tabs sit together and centred with a continuous line, and a tap on the old slot lands on a
neighbour. Measured in Chromium with iPhone emulation on the signed-in profile: tabs at 33, 98, 163,
228, 293 px; the hidden tab receives no hit. The Page tab row's inner tabs are labelled `Reels`
without a comma and keep their own rule.

## The Stories tray (ISS-0101, 20 Oct 2026)

On the phone Home feed the tray is one vscroller row: a horizontal scroller
(`[data-is-h-scrollable]`) four levels down whose cards are `[role="button"]`s labelled
`Create story` (the person's own, first) and `View <name> story. N new story` (or `stories`). No
main region, no `[data-virtualized]`, no `/stories/` links, so the desktop rule could not match.
The Stories extra now also hides that row, told by the scroller at that depth and those labels,
never a row holding a heading, an article, a Reel link or a `View reel video` button (the Reels
section is the free control's). Rows stack with margins, so hiding the row closes its gap.
