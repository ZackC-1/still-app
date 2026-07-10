# Release Testing Checkpoint - 2026-07-09

> Archived historical handoff. It does not describe current repository or store state. See
> [`../../release/VALIDATION.md`](../../release/VALIDATION.md) for current evidence.

Use this checkpoint to resume release testing after the updated build/parallel sync PR work is ready.

## Current State

- iOS App Store version `1.0` remains submitted for App Review with build `2`.
- iOS App Store Connect metadata, privacy, pricing/availability, IAP attachment, iPhone screenshots,
  and required 13-inch iPad screenshot are complete.
- Availability remains United States and Canada only.
- Apple IAP `Still Pro` / product id `still_sync` is `Ready to Submit`.
- RevenueCat/App Store product lookup works in the Apple paywall:
  - iOS paywall showed `Unlock Pro - $1.99`.
- Real Apple sandbox purchase is still not proven because the physical device sandbox Apple Account
  would not stay signed in. Treat this as Apple sandbox auth/device state unless new evidence points to
  app code.
- Promotional RevenueCat entitlement remains the proven entitlement path for test account:
  - Email: `REDACTED_TEST_ACCOUNT`
  - Supabase user id: `REDACTED_TEST_USER_ID`
  - App UI showed `Synced across your devices`.
  - Backend row confirmed `public.entitlements.still_sync = true`, `source = reconcile`,
    `updated_at = 2026-07-09 01:16:56.864474+00`.

## Functional Tests Completed

### iOS App + Safari Extension

- Free YouTube Shorts blocking: **Pass** based on physical-device testing.
- Entitled account state: **Pass** (`Synced across your devices`).
- Instagram Reels: **Pass**. Reels are removed/blocked, and toggling Still on/off makes Reels
  disappear/reappear.
- TikTok: **Pass**. Mobile TikTok is blocked effectively.
- Facebook Reels route/content: **Pass** functionally. Reels viewing is blocked.
- Facebook home Reels tab residue: **Known visual issue**. Facebook mobile home still shows a gray
  residue/slot where the Reels tab was hidden/removed. Tracked as:
  - https://github.com/ZackC-1/still-app/issues/58
- iOS local settings persistence: **Pass**. User reported persistence works as anticipated.
- iOS Restore Purchase visibility: not visible while signed in as an already-entitled account; this is
  **non-blocking** for that state.

### macOS App + Safari Extension

- Local macOS debug build: **Pass**.
  - Command: `apps/apple/scripts/build.sh macos`
  - Built `Still.app` version `1.0` build `2`.
- Safari extension enabled and tested on Mac.
- YouTube direct Shorts URL: **Pass**.
  - Safari first blocks `/shorts/`, then redirects to `/watch?...`.
- YouTube sidebar/search cleanup: **Pass**.
  - Shorts are hidden effectively.
  - Broad search such as `music` keeps Shorts removed while normal YouTube remains usable.
- Entitled account state: **Pass**.
  - macOS app shows `Synced across your devices`.
- Instagram Reels: **Pass**.
- Facebook desktop Reels: **Pass**.
- TikTok: **Pass**.
- Same-device app-to-Safari setting propagation: **Pass**.
  - Turning TikTok off/on in the macOS app affects Safari blocking as expected.

## Decisions / Product Notes Captured

- Near-realtime, latest-surface-wins settings sync is desired follow-up behavior, not current release
  behavior.
  - Spec: `docs/plans/2026-07-09-001-near-realtime-settings-sync-spec.md`
  - Parallel implementation prompt: `docs/plans/2026-07-09-002-near-realtime-sync-pr-agent-prompt.md`
  - A separate Codex session is working on that PR in a separate worktree.
- Restore purchase decision rule was documented:
  - Entitled Supabase account → auto-provision Pro through reconcile; no Restore button needed.
  - Unentitled account → show upgrade path plus secondary `Restore purchase` in the paywall.
  - `Restore purchase` is specifically Apple receipt recovery for an Apple ID that already owns
    `still_sync` but whose current Supabase account is not yet entitled.
  - Web purchase restore remains sign in → backend reconcile.
  - Docs updated: `docs/monetization-design.md`, `docs/release/04-revenuecat.md`.

## Code / Build Notes From This Session

- Facebook mobile Reels hiding fixes were attempted and tested locally:
  - Rules seed bumped/re-signed to `1.0.2`.
  - Mobile Facebook Reels tab moved to JS remove behavior via `fb-mobile-tabs`.
  - Safari extension build pipeline updated so Xcode copy phases rebuild `@still/ext-safari` before
    copying `packages/ext-safari/dist/safari-mv3`.
  - Xcode shell phases now locate `pnpm` via `/opt/homebrew/bin:/usr/local/bin`.
- Despite these fixes, iOS Facebook home gray residue persisted on-device, so it was filed and testing
  moved on.
- Do not revert unrelated dirty changes. Known dirty work includes release docs, Supabase function files
  from the earlier CORS fix, rule/test changes, generated CSS, and Apple build phase/script changes.

## What Needs Testing Next

### 1. Apple Paywall Restore Visibility

Use an unentitled signed-in account.

1. Open the Apple app after the updated build is installed.
2. Sign in with an account that does **not** have `still_sync`.
3. Tap/click a locked Pro service row, such as TikTok, Instagram Reels, or Facebook Reels.
4. Confirm the Pro paywall opens.
5. Expected:
   - Primary button: `Unlock Pro - $1.99` or equivalent localized price.
   - Secondary button: `Restore purchase`.
6. If `Restore purchase` is not visible in the paywall, treat as an Apple release blocker/UI bug.

### 2. Cross-Apple Current Sync Smoke Test

This is for the current build, not the near-realtime follow-up PR.

1. Sign in to iOS and macOS as the same entitled account.
2. Toggle one service on iOS.
3. Check whether macOS eventually reflects it after app relaunch/resume/reconcile.
4. Toggle one service on macOS.
5. Check whether iOS eventually reflects it after app relaunch/resume/reconcile.
6. Record current behavior honestly. Near-realtime behavior is being built separately.

### 3. macOS App Store Submission Blockers

1. Prepare/upload macOS screenshots.
2. Archive the macOS app in Xcode.
3. Upload/select the macOS build in App Store Connect.
4. Confirm macOS app metadata/version state.
5. Confirm `still_sync` IAP is attached/available for the macOS version as needed.
6. Submit macOS version `1.0` for review.

### 4. Chrome Extension Free + Pro Testing

1. Build/load the Chrome extension on a clean Chrome profile.
2. Verify free YouTube Shorts blocking:
   - sidebar/guide Shorts removed;
   - direct `/shorts/` redirects/blocks;
   - search Shorts removed while normal videos remain.
3. Sign in with the entitled account.
4. Confirm Pro/sync state.
5. Verify Instagram Reels, Facebook Reels, and TikTok blocking.
6. Verify settings toggle persistence and same-browser propagation.
7. Verify RevenueCat Web Billing sandbox checkout/reconcile path if portal setup is ready.
8. Prepare Chrome Web Store listing/privacy/payment disclosures.

### 5. Firefox Desktop Free + Pro Testing

1. Build/load the Firefox extension.
2. Verify free YouTube Shorts blocking.
3. Sign in with the entitled account.
4. Verify Instagram Reels, Facebook Reels, and TikTok blocking.
5. Verify settings toggle persistence and same-browser propagation.
6. Verify Web Billing checkout/reconcile if ready.
7. Build AMO package and source package.
8. Validate AMO reviewer requirements: source package, privacy disclosure, payment checkbox, and
   Firefox data-collection consent metadata.

### 6. Firefox Android Mobile YouTube Validation

Optional if a device/emulator is available.

1. Install/load the Firefox Android-compatible build.
2. Visit mobile YouTube.
3. Verify direct Shorts URL redirects before playback.
4. Verify Shorts shelves/tabs are removed while normal videos remain.

## Docs To Read First Next Time

- `docs/release/2026-07-09-functional-testing-matrix.md`
- `docs/release/2026-07-09-release-testing-checkpoint.md`
- `docs/release/next-session-after-updated-build-testing-prompt.md`
- `docs/release/01-apple-app-store.md`
- `docs/release/04-revenuecat.md`
- `docs/release/02-chrome-web-store.md`
- `docs/release/03-firefox-amo.md`
- `docs/release/06-mobile-blocking-validation.md`
