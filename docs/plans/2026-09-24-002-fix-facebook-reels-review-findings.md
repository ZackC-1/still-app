---
title: Address PR 213 selector safety and delivery findings
status: implemented (awaiting store rebuild)
owner: Codex
branch: fix/facebook-page-reels-tab
date: 2026-09-24
---

# Address PR 213 selector safety and delivery findings

## Outcome

Keep the measured Facebook Page Reels tab steadily hidden while preserving ordinary content.
Update PR #213 on its existing branch, without merging or publishing store artifacts or remote rules.
This plan supersedes the shelf-removal and remote-delivery decisions in
[the original plan](2026-09-24-001-fix-facebook-page-reels-tab-flicker.md).

## Evidence and decisions

The review independently reproduced the tab loop on a public Page in Chromium: 75 of 150 frames
visible under the old CSS, zero under the replacement CSS. The fixture reproduces the same behavior
in Chromium, Firefox and WebKit.

1. Defer the empty shelf header cleanup. The four-ancestor selector can hide the whole feed when a
   wrapper disappears. Remove `fb-feed-shelf`; preserve its fixture as an ordinary-content guard.
   This also removes the newly added dependency on `:has()`, unavailable before Safari 15.4 despite
   the existing iOS 15.0/macOS 12.0 deployment targets. Do not broaden this fix into the pre-existing
   repository-wide browser compatibility gap.
2. Narrow the More-menu rule to the recorded absolute Facebook destination, radio menu item role,
   checked-state attribute, and exact `/reels_tab` ending. Exclude the root vanity Page and groups.
   Ordinary menu links, vanity names beginning with `reels_tab`, external destinations and query
   values must stay visible. Unrecognized menu markup should remain visible rather than over-hide.
3. Require rebuilt store packages. New fetched JS hide rules do not disable old packaged CSS, so a
   remote rule publication alone does not stop the old href mutation loop.
4. Preserve the content-only tab fix and existing focus tradeoff. Following the hidden tab continues
   to reach the placeholder. No new permissions, collection, engine abstraction or native-app claim.

## Work units

### U1: Correct the documentation

Update the original plan, solution and signing guide to remove claims of safe shelf-depth drift and
remote-only delivery. Record the known empty-header limitation and supported-engine boundary.

### U2: Add regression coverage, then narrow rules

Add ordinary menu links that the current selector over-hides. Add a feed whose Reels grid is one
wrapper shallower and whose sibling is an ordinary post. Verify these fail against the current PR.
Then remove the shelf surface, narrow the menu selector, sign the seed and regenerate both CSS files.
Keep rule version 1.1.10: it is still an unpublished PR revision, not a replacement for a published set.
Exercise the same menu cases through `applyDom` to verify the fetched-rule selector path.
Permit the literal query marker `?` in the safe-selector character allowlist, with injection-negative
coverage. The existing validator rejects it even inside quoted href values; excluding query values
requires this small validator change. Preserve all forbidden-token and pseudo-class restrictions.

### U3: Verify and update PR #213

Run lint, typecheck, unit tests, all builds and the fixture suite. Repeat the flicker regression.
Check the diff, signature and generated CSS parity. Update the PR description to describe the final
scope and actual verification, commit only task-owned files, and push the existing branch.
Do not merge, comment on the PR, publish a production rule set, or submit store packages.

## Verification contract

- Positive: Reels tab contents and the recorded More entry hide; href remains stable across frames.
- Negative: All/Photos/Live, vanity Pages, ordinary links to Reels, external links, and normal feed
  posts remain visible. A shallower Reels grid cannot hide its containing feed.
- Deferred shelf: reel tiles still disappear through existing rules; an empty header may remain.
- JS: the same narrowed menu selector preserves the negative cases under `applyDom`.
- Gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm exec playwright test --project=fixtures`.

## Risks and limits

The menu selector deliberately follows observed markup; other origins or route shapes may need a
future observed rule. This PR adds no `:has()` dependency but does not make all existing rules work
on old Safari. Native Safari minimum-version testing remains unavailable. The keyboard-focusable
empty tab remains the documented #58 tradeoff.

## Definition of done

All four review findings are fixed or explicitly removed from scope with regression protection;
the documentation describes the actual rollout; required checks pass; the changes are pushed to
PR #213 without merging it. Store release remains a separate owner action.

## Verification evidence

The new menu and shelf safety fixture tests failed against the original PR build. The new JS-menu
test also failed before the selector change. After implementation, lint, typecheck, unit tests
(822 core, 81 Safari, 63 Chromium passed; 39 skipped), all builds and fixtures (54 passed, 2 skipped)
passed. Signature, schema acceptance and generated CSS parity are covered by the unit suite.
Native Chromium, Firefox and WebKit fixture probes each preserved all menu controls and the
shallower feed's ordinary post, with zero visible tab frames or href mutations in 40 frames.
Final diff review checked selector boundaries, the literal query-marker allowance, test failure
evidence, generated artifacts and delivery claims. No additional blocking finding remained.
