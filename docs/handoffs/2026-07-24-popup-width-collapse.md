---
title: "Popup width-collapse fix handoff"
status: active
created: 2026-07-24T09:40:00-07:00
source: "claude"
intended_receiver: "any"
---

# Popup width-collapse fix handoff

## Repository state

- Repository: `/Users/zack/Projects/still-app`
- Worktree: main worktree (single)
- Branch: `fix/popup-width-collapse` (pushed to origin)
- HEAD: `69eef62` — "fix(ext): stop popup collapsing to a sliver (fixed px width, not 100vw)"
- Upstream/ahead/behind: 1 commit ahead of `origin/main`; PR **not yet opened**
- Dirty files and ownership: none tracked. Build output only — see External state.

## Objective

The Chrome extension browser-action popup rendered as a one-character-wide vertical sliver
(user screenshot, 2026-07-24). Diagnose, fix on every affected surface, add a regression guard,
and produce an uploadable Chrome Web Store package (the user uploads it manually).

## Completed

- **Root cause identified.** `.popup { inline-size: min(380px, 100vw); max-inline-size: 100vw }` in
  the browser-action popups. Introduced in commit `9190de5` ("unify branding across app surfaces").
  A browser-action popup has NO predefined viewport — the browser derives the popup window width
  FROM rendered content, so `100vw` → ~0 during that pass, `min(380px, 0) = 0`, popup collapses.
- **Fixed both affected surfaces** → `inline-size: 380px` (fixed px, no viewport units), with an
  explanatory comment:
  - `packages/ext-chromium/entrypoints/popup/PopupApp.svelte`
  - `packages/ext-safari/entrypoints/popup/PopupApp.svelte`
- **Regression guards added** (fail if any `vw`/`vh` unit returns to popup sizing):
  - `packages/ext-chromium/lib/__tests__/popup-width.test.ts`
  - `packages/ext-safari/lib/__tests__/popup-width.test.ts`
  - (Both live under `lib/` because each package's vitest only includes `lib/**/*.test.ts`.)
- **Repo-wide audit done.** Only these two files used a viewport-unit width. Other `vw` hits are
  legitimate responsive typography on real-viewport pages (`docs/assets/marketing.css`,
  `docs/release/screenshots/source/*.html`) — not popups, not affected.
- **Version bumped** `@still/ext-chromium` 1.0.3 → 1.0.4 (covers both chrome-mv3 and firefox-mv3
  builds, which share the code). `ext-safari` deliberately left at 1.0.3 (Apple versioning lives in
  Xcode/ASC and the macOS review is mid-flight — do not disturb that artifact).
- **Store zips rebuilt** from this branch (see External state).

## Remaining

1. Open the PR from `fix/popup-width-collapse` → `main` (use `ce-commit-push-pr` or `gh pr create`).
2. Run `ce-code-review`, self-heal any findings, then merge to `main` (protected-branch workflow).
3. **User action:** upload `dist/stillext-chromium-1.0.4-chrome.zip` to the Chrome Web Store.
   - Note: Chrome 1.0.3 is currently in review. Uploading 1.0.4 replaces the in-review draft (Chrome
     allows a new package version on the same item). Confirm auto-publish-on-approval is still set.
4. **Firefox** shares this bug and is LIVE at 1.0.3 — its users have the same broken popup. Upload
   `dist/stillext-chromium-1.0.4-firefox.zip` to AMO (slug `still-free-yourself`) as well.
5. **Safari/Apple:** the popup fix is committed but rides the NEXT macOS/iOS build. The current
   macOS build 5 in re-review does NOT contain it. Do not resubmit solely for this; fold it into the
   next Apple build after the 5.1.1(v) re-review resolves.
6. Optional but recommended: a live-popup screenshot verification was skipped at pause. Can load the
   built popup at a near-zero viewport to visually confirm 380px if desired.

## Decisions and evidence

| Decision or fact | Evidence |
|---|---|
| `100vw` in a browser-action popup collapses to a sliver | Built 1.0.3 CSS shipped `.popup{inline-size:min(380px,100vw)}`; matches user screenshot (content renders but ~1 char wide) |
| Only two files carried the bug | `grep -rnE "100vw\|[0-9]+vw" --include=*.svelte/*.css/*.html` over src/entrypoints — only the two popups |
| Fixed px is the correct popup width | Standard browser-action popup practice; options page (real tab) correctly uses `max-inline-size: 480px` and never collapsed |
| Bump Chrome only, not Safari | AGENTS.md: do not alter a store artifact under active review merely to sync git |

## Verification performed

| Command or manual check | Result | Time |
|---|---|---|
| `pnpm --filter @still/ext-chromium typecheck` | clean (exit 0) | 2026-07-24 09:34 |
| `pnpm --filter @still/ext-chromium test` | 7 files, 23 tests pass (incl. new guard) | 09:34 |
| `pnpm --filter @still/ext-safari test` | 6 files, 51 tests pass (incl. new guard) | 09:35 |
| `pnpm --filter @still/ext-chromium zip` | `dist/stillext-chromium-1.0.4-chrome.zip` (495.74 kB) | 09:35 |
| `pnpm --filter @still/ext-chromium zip:firefox` | `...-1.0.4-firefox.zip` + `...-sources.zip` | 09:35 |
| Built `dist/chrome-mv3/assets/popup-*.css` inspected | `.popup{inline-size:380px;margin-inline:auto;overflow:clip}` — no vw | 09:35 |
| Built `dist/chrome-mv3/manifest.json` version | `1.0.4` | 09:35 |

Not yet run (do before merge): `pnpm lint`, root `pnpm typecheck`/`pnpm test`, CI on the PR.

## External state

- Chrome Web Store: 1.0.3 in review (per prior release memory). 1.0.4 zip built locally, NOT yet
  uploaded.
- Firefox AMO: 1.0.3 LIVE (slug `still-free-yourself`) — carries the same bug; 1.0.4 zip built, NOT
  uploaded.
- macOS App Store: build 5 in 5.1.1(v) re-review; unaffected by this branch.
- Build artifacts (gitignored, on local disk, survive a session restart unless `dist/` is cleaned):
  - `packages/ext-chromium/dist/stillext-chromium-1.0.4-chrome.zip`
  - `packages/ext-chromium/dist/stillext-chromium-1.0.4-firefox.zip`
  - Rebuild anytime: `cd packages/ext-chromium && pnpm zip && pnpm zip:firefox`

## Blockers and human gates

- Chrome Web Store + AMO uploads are human portal actions (the user uploads the zip).
- No credential needed for the code merge.

## Next safe action

`gh pr create` from `fix/popup-width-collapse` (HEAD `69eef62`), or run `ce-commit-push-pr`. Nothing
on this branch must not be touched — it is self-contained. Do NOT re-run or resubmit the macOS build
to sync git; the Safari popup fix waits for the next Apple build.

## Relevant references

- Strategy: `STRATEGY.md`, product truth "all Still functionality in the popup window"
- Prior release state: memory `still-release-execution-plan` (2026-07-21 launch, 3/4 stores live)
- Culprit commit: `9190de5` "feat: unify branding across app surfaces"
