---
title: "Keep the Facebook Page Reels tab hidden instead of flickering"
status: implemented (awaiting review and store rebuild)
date: 2026-09-24
owner: "Claude Code; review fixes by Codex"
branch: "fix/facebook-page-reels-tab"
---

# Keep the Facebook Page Reels tab hidden instead of flickering

## Outcome

With Still on, a desktop Facebook Page or profile keeps its Reels tab contents hidden steadily.
The recorded Reels radio-menu entry in the Page's More menu is hidden; ordinary content survives.
The [review remediation plan](2026-09-24-002-fix-facebook-reels-review-findings.md) records the
selector-safety changes and supersedes the original shelf-removal and remote-delivery decisions.

## Context and evidence

- Product constraint: [STRATEGY.md](../../STRATEGY.md), remove Reels while preserving ordinary content.
- Rules: `packages/core/rules/seed.json`; CSS: `packages/core/scripts/gen-content-css.mjs`.
- Signing: [production rule-set keys](../production-rule-set-keys.md).
- Prior approach: `fb-mobile-tabs` (#58) hides a measured tab's children.

The original implementation's signed-in probes found an alternating tab: with its href present,
Still hid the tab itself; Facebook then removed its href and marked it hidden/disabled as an
overflowed item; the CSS stopped matching and the tab reappeared. Facebook restored its href and
the cycle repeated. Injecting only the old CSS reproduced this without the extension.

Independent review on Bon Appétit's public Page reproduced 150/150 visible frames with blocking
off, 75/150 with the old CSS and 149 href changes, and zero visible frames or changes with the new
CSS. The built extension also kept the tab at zero width across 150 frames. Fixture probes cover
Chromium, Firefox and WebKit; live independent verification covered Chromium only.

## Scope and decisions

- Hide the Page tab's children with `> *`, preserving its measurable zero-width box.
- Hide only the observed More entry: a checked-state radio menu item with an absolute
  `https://www.facebook.com/` address ending exactly in `/reels_tab`. Exclude root vanity Pages,
  group routes, and query/fragment values. Unknown markup fails open.
- Retain version 1.1.10 for this unpublished PR revision, re-sign with the development key and
  regenerate Chromium and Safari CSS. Firefox shares the Chromium generator.
- Defer empty feed-header cleanup. The rejected four-ancestor selector can hide an entire feed
  when one wrapper disappears. Existing rules still remove reel tiles; an empty header may remain.
- Permit literal `?` in selector data so the menu rule can exclude query strings. Keep forbidden
  CSS tokens and pseudo-class restrictions intact. No action-engine changes, production rule
  publication, store submission, permissions or collection changes.

## Work units

1. Update the seed and both generated stylesheets; verify signing and generated parity.
2. Model the tab-overflow interaction in a hand-written fixture. Assert zero visible frames and
   href mutations, preserve neighboring tabs, and cover menu vanity names, groups, external links,
   query values and ordinary links. Guard a shallower grid's ordinary sibling post.
3. Verify the menu selector through the JS sweep, run repository gates, and update the learning.

## Acceptance scenarios

1. After settling, the Page tab contents remain hidden throughout sampling and its href stays stable.
2. The recorded More-menu Reels entry hides while Live and ordinary menu destinations remain visible.
3. Reels grid ancestry never hides the surrounding feed or its ordinary posts.
4. Disabling Still restores CSS-hidden content; direct Reels routes continue to show the placeholder.

## Risks and recovery

- The empty tab remains keyboard-focusable, as in #58; Enter reaches the placeholder.
- The exact menu shape is evidence-based, not a guarantee about unobserved Facebook variants.
- New selectors use no `:has()`. Safari 15.0 to 15.3 lacks that feature; this revision removes the
  new shelf dependency but does not repair the repository's pre-existing compatibility gap.
- An ancestor count is not a shelf boundary. Future cleanup requires independently identified card
  boundaries, negative nesting tests, compatible fallback behavior and realistic performance checks.

## Delivery

Ship rebuilt Chrome, Firefox and Safari packages through the existing store-release process.
A remote signed rule set alone cannot replace the old packaged CSS. Old CSS plus new JS hide rules
still caused 39 to 40 href changes in 40 fixture frames, even after the contents became invisible.
Do not advertise remote publication as a complete fix for those installations.

## Verification evidence

Independent review before remediation: lint, typecheck, tests (964 passed, 39 skipped), build and
fixtures (53 passed, 2 skipped) passed. The original flicker regression failed all three repetitions
with main's old rules (20/40 visible frames) and passed five repetitions with the replacement.
Live Chromium showed placeholders for `/<page>/reels/`, `/reel/<id>` and `/watch` after its redirect.

The remediation commit and PR description record the checks run on the final rules. Minimum-version
Apple devices remain unverified. Store rebuilds/submissions are a separate owner action.
