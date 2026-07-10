# Release Session Checkpoint - 2026-07-07

> Archived historical handoff. It does not describe current repository or store state. See
> [`../../release/VALIDATION.md`](../../release/VALIDATION.md) for current evidence.

This file captures the exact release state when the walkthrough paused.

## Current Focus

We are preparing the first App Store release for Still, starting with iOS, then macOS, then later Chrome, Safari, and Firefox.

## App Store Connect State

- App: `Still: Free Yourself`
- Apple app ID: `6784061138`
- App Store Connect app records exist for:
  - iOS App 1.0 - Prepare for Submission
  - macOS App 1.0 - Prepare for Submission
- Agreements, banking, and tax are active.
- App Information is filled in.
- Age rating fields were completed and saved.
- App Privacy was completed and published.
- Availability was intentionally limited to the United States and Canada.
- Screenshots:
  - Three iPhone screenshots have been uploaded and accepted into the iOS product page screenshot area.
  - We converted source screenshots into 6.5-inch iPhone compatible JPEGs at `1242 x 2688`, RGB, no alpha.

## In-App Purchase State

- IAP display/reference name: `Still Pro`
- Product ID: `still_sync`
- Type: non-consumable
- Price: `$1.99`
- IAP status is now `Ready to Submit`.
- The IAP Review Information screenshot issue was resolved by uploading a flattened JPEG.
- Important distinction:
  - IAP promotional image requires `1024 x 1024`.
  - IAP Review Information screenshot must be a normal supported App Store screenshot size.

## Current iOS Version Blockers

On the iOS App Version 1.0 page, `Add for Review` showed these blockers:

1. `You must choose a build.`
2. `User name - This field is required`
3. `Password - This field is required`

Next steps when resuming:

1. Select an existing iOS build if available.
2. If no build exists, archive/upload an iOS build from Xcode.
3. Fill App Review sign-in fields.
4. Then click `Add for Review` again and resolve any remaining blockers.

Suggested App Review sign-in handling:

- The app uses email code sign-in, not a password.
- Use reviewer notes to explain: "The app uses email code sign-in. Enter the email, request a code, and use the emailed code to sign in."
- We need decide whether to use `REDACTED_TEST_ACCOUNT` or a dedicated reviewer/demo email.
- If App Store Connect requires a password value, use a non-secret placeholder such as `Code sent by email`, and explain in Review Notes.

## RevenueCat State

- RevenueCat project exists for Still.
- App Store app is configured in RevenueCat.
- RevenueCat credentials were uploaded and showed valid:
  - App Store Connect API key
  - In-app purchase key
- Product catalog:
  - Apple product: `still_sync`
  - Web Billing product: `still_sync_web`
  - Entitlement: `still_sync`
  - Current offering: `still_sync_web`
  - Offering package grants lifetime access to the Apple product `still_sync` and web product `still_sync_web`.
- Webhook is configured:
  - `https://kikpgrreradotvvefdgd.supabase.co/functions/v1/revenuecat-webhook`
  - Both Production and Sandbox events enabled.

Open issue:

- Device logs showed RevenueCat warnings that offerings `default` and `still_sync` had no packages.
- After the IAP became `Ready to Submit`, re-test purchase/price loading because App Store metadata can take time to propagate.
- If still failing, verify the current RevenueCat offering has a package containing App Store product `still_sync`.

## Supabase / Sync State

- Supabase project ref: `kikpgrreradotvvefdgd`
- Policies for `profiles` were checked and looked correct.
- Auth user exists for `REDACTED_TEST_ACCOUNT`.
- `public.entitlements` had no rows when checked.

Open issue:

- On iPhone, after signing in with `REDACTED_TEST_ACCOUNT`, Still showed `Sync paused - no connection`.
- Code inspection showed this comes from `SyncService` when:
  - `reconcile-entitlement` throws, or
  - `readEntitlement()` returns `unknown`.
- Need capture device logs for `reconcile-entitlement`, `Supabase`, `FunctionsHttpError`, `RevenueCat`, `401`, `403`, `500`, `failed`, or network errors.
- The app sign-in itself is working; the failure is in the post-sign-in reconcile/read path.

## Device Testing State

- iPhone device was connected and visible to CoreDevice.
- YouTube Shorts blocking works on iOS with Safari.
- Instagram/TikTok/Facebook Pro unlock testing is blocked until purchase/entitlement is working.
- Sandbox tester exists: `REDACTED_SANDBOX_TESTER`.
- Do not store or rely on old sandbox password values; user said password was reset/ready.

## Local Repo State

Workspace: `REPOSITORY_ROOT`

One local code edit was made:

- `apps/apple/scripts/build.sh`
- Changed an echo line to use ASCII and `${DEVICE_UDID}` interpolation:
  - `device ${DEVICE_UDID}...`

Do not revert unrelated user changes.

## Resume Order

1. Finish iOS App Store Connect blockers:
   - build selection/upload
   - App Review username/password fields
2. Re-run `Add for Review` validation.
3. Return to device logs and diagnose `Sync paused - no connection`.
4. Re-test RevenueCat offerings after IAP metadata propagation.
5. Sandbox purchase test.
6. Then move to macOS version page.
