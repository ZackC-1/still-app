# Fresh Session Prompt - Testing After Updated Build

Use this prompt in a new Codex session after the updated Still build is ready.

```text
I’m resuming the Still app release after an updated build completed. Please act as a detailed
interactive release assistant and coding/debugging partner. Guide me step by step through the next
testing paradigm across Apple, Chrome, Firefox, and store submission surfaces. Tell me exactly where
to click in the app, Safari, App Store Connect, RevenueCat, Supabase, Xcode, Chrome, and Firefox when
needed. Use the local repo to inspect/debug issues and make code/doc updates when needed.

Repo:
- /Users/zack/Projects/still-app

Important:
- A separate Codex session may be working on near-realtime settings sync in a separate worktree:
  /Users/zack/Projects/still-app-sync-pr
- Do not touch that worktree unless I explicitly ask.
- The main release-testing checkout may be dirty. Do not revert unrelated changes.
- For code-flow questions, follow AGENTS.md and use CodeGraph before reading source files.

Before doing anything, read these files:
- /Users/zack/Projects/still-app/docs/release/2026-07-09-release-testing-checkpoint.md
- /Users/zack/Projects/still-app/docs/release/2026-07-09-functional-testing-matrix.md
- /Users/zack/Projects/still-app/docs/release/01-apple-app-store.md
- /Users/zack/Projects/still-app/docs/release/04-revenuecat.md
- /Users/zack/Projects/still-app/docs/release/02-chrome-web-store.md
- /Users/zack/Projects/still-app/docs/release/03-firefox-amo.md
- /Users/zack/Projects/still-app/docs/release/06-mobile-blocking-validation.md

Current known state:
- iOS App Store version 1.0 was submitted for App Review with build 2 selected.
- iOS core functional testing passed:
  - YouTube Shorts blocking works on iOS Safari.
  - Entitled account shows `Synced across your devices`.
  - Instagram Reels and TikTok are blocked on iOS Safari.
  - Facebook Reels viewing is blocked, but Facebook mobile home still has a gray Reels slot/residue.
    This is tracked as GitHub issue #58 and should not block functional testing unless new evidence
    shows Reels content is viewable.
- macOS Safari core functional testing passed:
  - Direct YouTube Shorts URLs block and redirect to `/watch?...`.
  - YouTube Shorts sidebar/search cleanup works.
  - Entitled account shows `Synced across your devices`.
  - Instagram Reels, Facebook desktop Reels, and TikTok block effectively.
  - Same-device macOS app -> Safari TikTok toggle propagation works.
- Apple sandbox purchase is still not proven because the physical device sandbox Apple Account would
  not stay signed in. Treat this as sandbox/device auth unless new evidence points to app code.
- RevenueCat promotional entitlement has proven the entitlement spine for:
  - `zack+sandbox2@cadmuslabs.co`
  - Supabase user id `2a592992-74b2-4b6d-b425-cf5db63510a5`
  - Backend row: `public.entitlements.still_sync = true`, `source = reconcile`,
    `updated_at = 2026-07-09 01:16:56.864474+00`.
- Restore purchase decision rule is documented:
  - Entitled Supabase account auto-provisions Pro after reconcile; no Restore button needed.
  - Unentitled account should see upgrade plus secondary `Restore purchase` in the paywall.
  - Restore is Apple receipt recovery for an Apple ID that already owns `still_sync`.
  - Web purchase restore remains sign in -> backend reconcile.
- Near-realtime latest-surface-wins settings sync is desired follow-up behavior, not current release
  behavior. A parallel Codex session is implementing that from:
  - docs/plans/2026-07-09-001-near-realtime-settings-sync-spec.md

Start by updating or confirming the live test matrix, then guide me through this next testing order:

1. Apple paywall restore visibility after updated build
   - Use an unentitled signed-in account.
   - Open the Apple app.
   - Tap/click a locked Pro service row such as TikTok, Instagram Reels, or Facebook Reels.
   - Confirm the Pro paywall opens.
   - Expected:
     - Primary button: `Unlock Pro - $1.99` or localized equivalent.
     - Secondary button: `Restore purchase`.
   - If `Restore purchase` is missing from the paywall, treat as an Apple release blocker/UI bug and
     inspect/fix the app code.

2. Cross-Apple current sync smoke test
   - Sign in to iOS and macOS as the same entitled account.
   - Toggle one service on iOS and check whether macOS eventually reflects it after app
     relaunch/resume/reconcile.
   - Toggle one service on macOS and check whether iOS eventually reflects it after app
     relaunch/resume/reconcile.
   - Record current behavior honestly. Do not expect near-realtime until the parallel PR lands.

3. macOS App Store submission blockers
   - Prepare or verify macOS screenshots.
   - Archive the macOS app in Xcode.
   - Upload/select the macOS build in App Store Connect.
   - Confirm macOS metadata/version state.
   - Confirm `still_sync` IAP is attached/available for the macOS version as needed.
   - Submit macOS version 1.0 for review.

4. Chrome extension free + Pro testing
   - Build/load the Chrome extension on a clean Chrome profile.
   - Verify free YouTube Shorts blocking:
     - sidebar/guide Shorts removed;
     - direct `/shorts/` redirects/blocks;
     - search Shorts removed while normal videos remain.
   - Sign in with the entitled account.
   - Confirm Pro/sync state.
   - Verify Instagram Reels, Facebook Reels, and TikTok blocking.
   - Verify settings toggle persistence and same-browser propagation.
   - Verify RevenueCat Web Billing sandbox checkout/reconcile path if portal setup is ready.
   - Prepare Chrome Web Store listing/privacy/payment disclosures.

5. Firefox desktop free + Pro testing
   - Build/load the Firefox extension.
   - Verify free YouTube Shorts blocking.
   - Sign in with the entitled account.
   - Verify Instagram Reels, Facebook Reels, and TikTok blocking.
   - Verify settings toggle persistence and same-browser propagation.
   - Verify Web Billing checkout/reconcile if ready.
   - Build AMO package and source package.
   - Validate AMO reviewer requirements: source package, privacy disclosure, payment checkbox, and
     Firefox data-collection consent metadata.

6. Firefox Android mobile YouTube validation, if available
   - Install/load the Firefox Android-compatible build.
   - Visit mobile YouTube.
   - Verify direct Shorts URL redirects before playback.
   - Verify Shorts shelves/tabs are removed while normal videos remain.

As we test:
- Update /Users/zack/Projects/still-app/docs/release/2026-07-09-functional-testing-matrix.md with
  pass/fail/blocker results.
- Update the relevant release runbooks when results affect launch readiness.
- If you find a blocker, inspect/debug the local repo and implement a focused fix.
- Run relevant verification before declaring a fix complete.
- Keep Apple sandbox auth issues separate from app-side purchase/offering failures.
```
