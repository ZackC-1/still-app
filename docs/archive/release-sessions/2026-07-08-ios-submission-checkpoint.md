# Release Session Checkpoint - 2026-07-08

> Archived historical handoff. It does not describe current repository or store state. See
> [`../../release/VALIDATION.md`](../../release/VALIDATION.md) for current evidence.

This is the current handoff after the iOS App Store submission walkthrough.

## Current Focus

The iOS app has been submitted for App Review. Next work should shift from App Store Connect blockers
to end-to-end functional testing across all app surfaces, starting with Apple/iOS because it is already
in review, then macOS, Safari, Chrome, and Firefox.

## App Store Connect State

- App: `Still: Free Yourself`
- Apple app ID: `6784061138`
- App Store Connect app records exist for iOS and macOS.
- Agreements, banking, and tax are active.
- App Information, Age Rating, App Privacy, Pricing and Availability are complete.
- Availability is intentionally limited to the United States and Canada.
- iOS version `1.0`:
  - Build `2` was selected and saved.
  - `Still Pro` / product id `still_sync` was attached to the version and is `Ready to Submit`.
  - Three iPhone screenshots were uploaded and accepted.
  - The 13-inch iPad screenshot blocker was resolved by uploading:
    - `docs/release/screenshots/ipad/still-ipad-13-01.jpg`
  - App Review sign-in requirement was handled by setting sign-in required to `No` and using review
    notes from `docs/app-store-submission.md` because the free tier is usable without an account.
  - The app was submitted for review.
- macOS version `1.0` still needs its release walkthrough after iOS testing.

## RevenueCat / Purchase State

- RevenueCat project and App Store app are configured.
- Product catalog:
  - Apple product: `still_sync`
  - Web Billing product: `still_sync_web`
  - Entitlement: `still_sync`
  - Current offering/package now resolves the App Store product.
- The iOS paywall successfully loaded the StoreKit/RevenueCat price:
  - Button showed `Unlock Pro - $1.99`
  - This proves the current offering contains an App Store product package for `still_sync`.
- Apple sandbox account sign-in remains flaky on the physical device:
  - StoreKit product lookup works.
  - Purchase could not be completed because the sandbox Apple Account would not stay signed in, even
    after creating a new sandbox tester.
  - Treat this as an Apple sandbox auth/device issue, not an app offering/Supabase issue, unless a
    later direct purchase attempt produces app-side errors.

## Supabase / Entitlement State

- Supabase project ref: `kikpgrreradotvvefdgd`
- The original `Sync paused - no connection` issue was diagnosed and fixed.
- Root cause:
  - WKWebView/Supabase browser client sent an `OPTIONS` preflight for Edge Functions.
  - `reconcile-entitlement` returned `405` without CORS headers.
  - The client saw a `FunctionsFetchError`, so entitlement reconciliation failed after sign-in.
- Deployed fix:
  - `supabase/functions/_shared/store.ts`
  - `supabase/functions/reconcile-entitlement/handler.ts`
  - `supabase/functions/create-web-checkout/handler.ts`
  - `supabase/functions/delete-user/handler.ts`
  - `supabase/functions/export-user-data/handler.ts`
- The fix adds CORS headers and `OPTIONS` handling to the callable authenticated Edge Functions.
- Verified live:
  - `OPTIONS` returns `204` with CORS headers for the functions above.
  - User confirmed `Sync paused - no connection` is gone.

## Entitlement Test Result

Apple sandbox purchase could not be completed, so RevenueCat's dashboard grant was used to prove the
release-critical entitlement spine without charging.

- Test account:
  - Supabase email: `REDACTED_TEST_ACCOUNT`
  - Supabase user id: `REDACTED_TEST_USER_ID`
- RevenueCat customer:
  - Original app user id: `REDACTED_REVENUECAT_USER_ID`
  - Alias/app user id: `REDACTED_TEST_USER_ID`
- RevenueCat promotional entitlement:
  - Entitlement: `still_sync`
  - Product identifier: `rc_promo_still_sync_weekly`
  - Active through `2026-07-16T01:14:35Z`
- App result:
  - After signing in, the app showed `Synced across your devices`.
- Backend verification:
  - `public.entitlements.still_sync = true`
  - `source = reconcile`
  - `updated_at = 2026-07-09 01:16:56.864474+00`

This proves:

`RevenueCat active entitlement -> reconcile-entitlement -> Supabase entitlement row -> app Pro/sync UI`

Still not proven:

`Apple sandbox purchase sheet -> StoreKit transaction -> RevenueCat transaction -> webhook/reconcile`

That remaining gap is blocked by Apple sandbox auth, not by current offering/entitlement/Supabase
configuration.

## Local Repo State

Workspace: `REPOSITORY_ROOT`

Known local modifications:

- Pre-existing user edit:
  - `apps/apple/scripts/build.sh`
  - Echo line changed to ASCII/interpolated `${DEVICE_UDID}`. Do not revert.
- Release fix made and deployed:
  - `supabase/functions/_shared/store.ts`
  - `supabase/functions/create-web-checkout/handler.ts`
  - `supabase/functions/delete-user/handler.ts`
  - `supabase/functions/export-user-data/handler.ts`
  - `supabase/functions/reconcile-entitlement/handler.ts`
- New release artifacts/docs:
  - `docs/release/2026-07-07-release-session-checkpoint.md`
  - `docs/release/2026-07-08-ios-submission-checkpoint.md`
  - `docs/release/screenshots/ipad/still-ipad-13-01.png`
  - `docs/release/screenshots/ipad/still-ipad-13-01.jpg`

Temporary diagnostics were removed from the app source after the CORS fix was deployed.

## Verification Already Run

- TypeScript:
  - `pnpm --filter @still/core typecheck`
  - `pnpm --filter @still/app-webview typecheck`
- Supabase function tests:
  - `deno test --config supabase/functions/deno.json --allow-env --allow-net supabase/functions/reconcile-entitlement/handler.test.ts supabase/functions/create-web-checkout/handler.test.ts supabase/functions/__tests__/account.test.ts supabase/functions/revenuecat-webhook/handler.test.ts`
  - 39 passed, 0 failed.
- Supabase deploy:
  - `supabase functions deploy reconcile-entitlement create-web-checkout delete-user export-user-data --project-ref kikpgrreradotvvefdgd --import-map supabase/functions/deno.json`

## Recommended Next Session Order

1. Read this checkpoint and `docs/release/next-session-functional-testing-prompt.md`.
2. Rebuild/reinstall a clean current iOS debug build if testing from device; the submitted App Store
   build is build `2`, but local testing may have used temporary diagnostic builds during the session.
3. Complete iOS functional testing:
   - Free YouTube Shorts blocking on iOS Safari.
   - Pro surfaces on iOS Safari while signed in as the promoted-entitled test account.
   - Sync settings behavior across reinstall/relaunch where feasible.
   - Restore purchase behavior should reconcile the promotional entitlement; direct sandbox purchase
     can be retried later, preferably on another device or after Apple sandbox settles.
4. Move to macOS release walkthrough:
   - Build/archive/upload/select macOS build.
   - Upload macOS screenshots if needed.
   - Validate Safari extension enablement and free/Pro blocking on macOS Safari.
5. Test browser extension surfaces:
   - Chrome extension free tier and Pro web entitlement.
   - Firefox extension free tier and Pro web entitlement.
   - Firefox Android mobile YouTube validation if available.
6. Record pass/fail evidence in the relevant release docs.
