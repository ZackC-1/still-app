---
title: "Keep the Facebook Page Reels tab hidden instead of flickering"
status: implemented (awaiting review and store rebuild)
date: 2026-09-24
owner: "Claude Code"
branch: "fix/facebook-page-reels-tab"
---

# Keep the Facebook Page Reels tab hidden instead of flickering

## Outcome

With Still on, a signed-in desktop visitor to any Facebook Page or profile sees the tab row without
Reels (for example "All, About, Photos, Followers, More"), steadily, in Chrome, Firefox and Safari.
The tab never appears in the row or in the row's "More" menu, and every other tab is unchanged.
The home feed no longer leaves an empty "Reels" header card behind after Still removes the reels.

## Context and evidence

- Strategy: [`STRATEGY.md`](../../STRATEGY.md): Facebook Reels removal is a free 2.0 promise.
- Rule data: `packages/core/rules/seed.json` (`fb-page-tabs`), generated CSS from
  `packages/core/scripts/gen-content-css.mjs`, signing per
  [`docs/production-rule-set-keys.md`](../production-rule-set-keys.md).
- History: `cb711c0` added `fb-page-tabs` from a signed-out capture of facebook.com/facebook.
- Related solutions: `docs/solutions/ui-bugs/mobile-youtube-renderer-owned-nodes.md` (model a page
  renderer's contract in a fixture), `fb-mobile-tabs` (#58: hide a tab's contents, not the tab).

Live reproduction on 2026-09-24 (signed-in test account, release Chrome build of `origin/main`,
Pages buzzfeedtasty, bonappetitmag, nytcooking and a person profile):

- Still off: the Reels tab is `<a role="tab" href="https://www.facebook.com/<page>/reels_tab">`
  inside `[role="tablist"]`, stable, zero attribute mutations.
- Still on: the element toggles every frame between two states, about 60 href changes a second,
  forever. State 1: href present, matched by `fb-page-tabs`, `display:none`. State 2: href removed,
  `aria-hidden="true"`, `aria-disabled="true"`, `tabindex="-1"`; no selector matches, so it is
  visible and hit-testable. Sampling 150 frames: visible in 75. Screenshots show it or not at
  random, which is why earlier checks passed and the showcase capture failed.
- The same loop reproduces with Still off by injecting only the old rule as CSS, in Chromium,
  WebKit and Firefox. It is Facebook's tab-overflow logic reacting to `display:none`, not the
  engine, service scoping, tier CSS or the JavaScript sweep.
- Facebook treats a tab that has no layout box as overflowed: it disables the in-row copy and adds
  the tab to the "More" menu (observed: "Reels" appeared in More while the loop ran). At narrow
  widths it does the same to tabs that really overflow (Followers moved into More at 480px).

## Scope

### In scope

- `fb-page-tabs`: hide the Reels tab's contents (`> *`) so the tab keeps a zero-width layout box,
  which Facebook counts as fitting; also hide the tab's entry in the tab row's "More" menu.
- `fb-feed-shelf` (new hide surface): the home-feed Reels shelf card whose tiles `fb-watch`
  already removes, which otherwise remains as a header-only "Reels" card.
- Rule-set version 1.1.10, dev re-signature, regenerated packaged CSS.
- Fixture that models Facebook's overflow contract so the loop fails the old rule; tests for the
  menu entry and shelf card; over-blocking controls.

### Out of scope

- Engine or content-script code. The fix is rule data only, so a production-signed rule set can
  also deliver it to installed clients.
- Mobile web (`m.facebook.com`): `fb-mobile-tabs` hides the label correctly (verified live).
- Production rule-set publication and store rebuilds (owner gates below).

## Assumptions and decisions

| Item | State | Evidence or owner |
|---|---|---|
| Facebook's desktop tab label is wrapped in an element, never a bare text node | Confirmed | Live markup on four Pages and one profile |
| A zero-width tab with a box is treated as fitting | Confirmed | 0 mutations, Reels width 0, More menu without Reels, all three engines |
| Shelf card is exactly four levels above `[role="grid"][aria-label="Reels"]` | Confirmed live, may drift | Failure mode is the current empty header, never over-hiding |
| Remote production set can carry the fix | Inferred | Hide selectors apply via the JS sweep for fetched sets |

## Work units

### 1. Rule data

- Change: `fb-page-tabs` selectors to `a[role="tab"][href*="/reels_tab"] > *`,
  `[role="tablist"] a[href*="/reels_tab"] > *`, `[role="menu"] a[href*="/reels_tab"]`; add
  `fb-feed-shelf`; version 1.1.10; `sign-seed`; regenerate chromium and safari CSS.
- Verification: `content-css.test.ts` parity and scoping, rule-set unit tests.

### 2. Regression fixture and tests

- Change: `tests/fixtures/facebook.html` uses the live tab markup and an inline script modeling
  the overflow contract; `fixtures.spec.ts` asserts the tab stays hidden across frames with its
  address intact, the More-menu entry is hidden, the shelf card is hidden, and controls stay.
- Verification: the new test fails with the 1.1.9 selectors and passes with 1.1.10.

### 3. Live verification and learning

- Re-run the live probes with the rebuilt extension; capture `docs/solutions/` learning.

## Acceptance scenarios

1. Given a signed-in desktop Page with Still on, when the page settles, then the Reels tab is not
   visible in any sampled frame, the other tabs are visible, and no tab attributes churn.
2. Given the "More" menu is opened, then it lists no Reels entry, and the other entries remain.
3. Given the home feed scrolls past a Reels shelf, then no empty "Reels" header card remains and
   ordinary posts load.
4. Given Still is off, then all of the above render exactly as Facebook ships them.

## Risks and recovery

| Risk | Prevention | Recovery |
|---|---|---|
| Hidden tab is still keyboard-focusable | Accepted: it leads to `/reels/`, which shows Still's placeholder | Same trade-off as #58 |
| Facebook changes tab markup or shelf depth | Fixture models the contract; live smoke before release | Ship a new signed rule set |
| `:has()` shelf selector cost | Same shape as existing `fb-watch` rules | Remove the surface |

## External and human gates

- Store rebuilds of 2.1 for Chrome, Firefox and Safari from the merged commit.
- Optional: production-signed rule set (private key) to reach already-installed clients.

## Completion evidence

- [x] Relevant automated checks passed: `pnpm lint`, `pnpm typecheck`, `pnpm test` (core 820,
  ext-safari 81, ext-chromium 63 passed), `pnpm build`, `pnpm exec playwright test --project=fixtures`
  (53 passed, 2 skipped). The new flicker test failed on the 1.1.9 rules (Reels visible in 20 of 40
  frames) and passes on 1.1.10; the shelf test failed on 1.1.9 and passes.
- [x] Live checks, rebuilt Chrome build, signed-in test account, 2026-09-24: buzzfeedtasty,
  bonappetitmag, nytcooking and a person profile show Reels in 0 of 150 sampled frames with 0
  address changes (was 75 of 150 with 150 changes); the More menu has no Reels entry; All, About,
  Photos, Followers/Friends and More are unchanged; NASA (no Reels tab) is unchanged. The home feed
  showed no Reels header across 20 scrolls and kept loading. With Still off the new selectors match
  only the tab contents and the shelf card (home, a Page, search, groups feed).
- [x] Engines: the old rule loops and the new rules hold in Chromium, WebKit and Firefox (CSS
  injected into a signed-in session; Safari and Firefox builds share the generated CSS).
- [x] Mobile web (iPhone emulation): `fb-mobile-tabs` already hides the label; unchanged.
- [x] Reusable learning captured: `docs/solutions/ui-bugs/hiding-a-measured-tab-with-display-none-flickers.md`.
- [ ] Owner: store rebuilds and, optionally, a production-signed rule set (see gates).

## Decision log

| Date | Decision | Reason |
|---|---|---|
| 2026-09-24 | Hide contents rather than mark the tab from JavaScript | A JS marker that hid both states was tried live and still looped: any `display:none` on the tab trips Facebook's overflow logic |
| 2026-09-24 | Include the feed shelf header | Same visible symptom class, rule-data only, benign failure mode |
