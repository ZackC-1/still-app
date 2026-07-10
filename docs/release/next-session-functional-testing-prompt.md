# Fresh Session Prompt - Functional Testing Across Surfaces

Use this prompt to continue in a fresh Codex session.

```text
I’m continuing the Still app release after submitting the iOS app for App Review. Please act as a
detailed interactive release assistant and coding/debugging partner. Guide me step by step through
testing the complete functionality of the app across all surfaces, telling me exactly where to click
in the app, Safari, App Store Connect, RevenueCat, Supabase, Xcode, Chrome, and Firefox when needed.
Use the local repo to inspect/debug issues and make code/doc updates when needed.

Repo:
- /Users/zack/Projects/still-app

Before doing anything, read these files:
- /Users/zack/Projects/still-app/docs/release/2026-07-08-ios-submission-checkpoint.md
- /Users/zack/Projects/still-app/docs/release/06-mobile-blocking-validation.md
- /Users/zack/Projects/still-app/docs/release/01-apple-app-store.md
- /Users/zack/Projects/still-app/docs/release/04-revenuecat.md

Current release state:
- iOS is first priority; macOS next; Chrome/Firefox after Apple.
- iOS App Store version 1.0 has been submitted for App Review with build 2 selected.
- App Store Connect app metadata, age rating, app privacy, pricing/availability, IAP attachment,
  iPhone screenshots, and required 13-inch iPad screenshot are complete.
- Availability is US and Canada only.
- IAP `Still Pro` / product id `still_sync` is `Ready to Submit`.
- The app price loaded successfully in the iOS paywall as `Unlock Pro - $1.99`, proving the
  RevenueCat current offering resolves the App Store product `still_sync`.
- Apple sandbox purchase is still not proven because the physical device sandbox Apple Account would
  not stay signed in, even with a newly created sandbox tester. Treat this as a sandbox/device auth
  issue unless new evidence points to the app.
- RevenueCat dashboard promotional entitlement was granted to test account
  `zack+sandbox2@cadmuslabs.co` / Supabase user id
  `2a592992-74b2-4b6d-b425-cf5db63510a5`.
- After sign-in, the app showed `Synced across your devices`.
- Backend verification confirmed `public.entitlements.still_sync = true`, `source = reconcile`,
  updated at `2026-07-09 01:16:56.864474+00`.
- The prior `Sync paused - no connection` issue was fixed by adding CORS/OPTIONS handling to
  authenticated Supabase Edge Functions and deploying them.
- Temporary diagnostics were removed from app source.

Known local repo state:
- Pre-existing edit: `apps/apple/scripts/build.sh` echo line uses ASCII/interpolated
  `${DEVICE_UDID}`. Do not revert unrelated changes.
- Modified and deployed Supabase function files:
  - `supabase/functions/_shared/store.ts`
  - `supabase/functions/create-web-checkout/handler.ts`
  - `supabase/functions/delete-user/handler.ts`
  - `supabase/functions/export-user-data/handler.ts`
  - `supabase/functions/reconcile-entitlement/handler.ts`
- New release artifacts include:
  - `docs/release/2026-07-08-ios-submission-checkpoint.md`
  - `docs/release/next-session-functional-testing-prompt.md`
  - `docs/release/screenshots/ipad/still-ipad-13-01.jpg`

Verification already run:
- `pnpm --filter @still/core typecheck`
- `pnpm --filter @still/app-webview typecheck`
- Supabase Deno tests for reconcile/create-web-checkout/account/revenuecat-webhook: 39 passed.
- Deployed `reconcile-entitlement`, `create-web-checkout`, `delete-user`, and `export-user-data`
  to Supabase project `kikpgrreradotvvefdgd`.

Please start by creating a test matrix/checklist for all surfaces, then walk me through the iOS
physical-device tests first:
1. Free YouTube Shorts blocking in iOS Safari.
2. Pro mobile surfaces on iOS Safari using the entitled test account.
3. Settings sync behavior and entitlement persistence.
4. Restore/reconcile behavior.
5. Retry real Apple sandbox purchase only if useful; do not block the rest of functional testing on
   sandbox account auth.

After iOS, continue with:
6. macOS app/Safari extension testing and macOS App Store submission blockers.
7. Chrome extension free/Pro testing.
8. Firefox desktop free/Pro testing.
9. Firefox Android mobile YouTube validation if available.

As we test, update the relevant release documentation with results and blockers.
```
