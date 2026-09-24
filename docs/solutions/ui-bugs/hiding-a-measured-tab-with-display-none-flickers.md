---
title: Hide a site's measured tab by its contents, not with display:none
category: ui-bugs
track: bug
problem_type: integration_error
module: packages/core/rules
applies_when: A hide rule targets a tab or menu item that the site measures to decide what overflows, and the element keeps reappearing, flickers, or passes one check and fails the next
date: 2026-09-24
status: active
tags: [facebook, selectors, tabs, overflow, flicker, selector-drift]
---

## Symptom

With Still on, the Reels tab on a desktop Facebook Page or profile ("All, About, Reels, Photos")
was sometimes visible and sometimes not. A store screenshot showed it; an automated check that
retried `toBeHidden` passed. Visiting the tab's address still showed Still's placeholder.

## Cause

It was not selector drift, service scoping, tier CSS or the engine. Facebook's tab row treats a
tab with no layout box as overflowed. It then removes the tab's `href`, sets `aria-hidden`,
`aria-disabled` and `tabindex="-1"`, and offers the tab in the row's "More" menu instead. The rule
`a[role="tab"][href*="/reels_tab"]{display:none}` keyed on that `href`, so:

1. The tab has its address, the rule matches, `display:none`, no box.
2. Facebook strips the address; the rule stops matching; the tab is laid out and visible.
3. Facebook sees a box and restores the address; back to 1.

Measured live: about 60 `href` changes a second, visible in 75 of 150 sampled frames, forever.
Injecting only the old rule into a page without Still reproduced it in Chromium, WebKit and
Firefox, which is what proved the page's own logic was reacting.

## What did not work

Marking the tab from JavaScript while it still had its address and hiding the mark in both states
still looped: any `display:none` on the tab removes its box, which is the trigger.

## Fix

Hide the tab's contents: `a[role="tab"][href*="/reels_tab"] > *`. The tab keeps a zero-width box,
Facebook counts it as fitting, never strips the address, and the following tabs close up with no
gap. Also hide the tab's entry in the row's "More" menu, `[role="menu"] a[href*="/reels_tab"]`,
where Facebook puts it when a narrow window really does overflow. This is the same shape as the
mobile rule from issue #58 (`[role="tab"][aria-label*="reels" i] > *`). The label must be wrapped
in an element; a bare text node child would stay visible.

## Verification that catches it

- A single screenshot or a retrying visibility assertion cannot: each lands on a hidden frame
  half the time. Sample the element across many animation frames and count attribute mutations;
  a steady state has zero.
- `tests/fixtures/facebook.html` carries a small IntersectionObserver model of the overflow
  contract, and `fixtures.spec.ts` asserts zero visible frames and zero address changes. The old
  rule fails it with 20 of 40 frames visible.
- Before release, check live signed-in Pages with Still on and off (the capture profile under
  `~/.still-capture/`, copied, never committed).

## Prevention

Before writing `display:none` for an element inside a tab row, carousel or anything that
reflows by measuring its children, check whether the site changes the element when it loses its
box. Prefer hiding its contents or a wrapper the site does not measure, and prefer selectors on
attributes that do not change with visibility state.

Related: `docs/plans/2026-09-24-001-fix-facebook-page-reels-tab-flicker.md`,
`docs/solutions/ui-bugs/mobile-youtube-renderer-owned-nodes.md`.
