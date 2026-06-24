# Still — Apple build & ship pipeline (U20)

Scriptable `xcodebuild` wrappers for the recurring build/test/archive loop. First-run provisioning
and store metadata are GUI (Apple gates those); everything else here runs unattended.

| Script | What it does |
|---|---|
| `build.sh [ios-sim\|ios-device\|macos]` | Rebuilds the web bundle, then builds the chosen target. `ios-sim` is unsigned (smoke); device/macOS sign with `-allowProvisioningUpdates`. |
| `test.sh` | `swift test` (StillKit) + the workspace gate (lint · typecheck · unit · build) — the same checks CI runs. |
| `archive.sh` | Archives Still (iOS) and exports a signed App Store `.ipa` using an App Store Connect API key; `UPLOAD=1` uploads via `altool`. |
| `ExportOptions.plist` | App Store export config (managed signing, team `UM9HVDH3P3`). |

```sh
# Day-to-day
./build.sh ios-sim
./test.sh

# Release (needs the ASC API key — see below)
ASC_KEY_ID=XXXXXXXXXX ASC_ISSUER_ID=<uuid> ASC_KEY_PATH=~/AuthKey_XXXXXXXXXX.p8 UPLOAD=1 ./archive.sh
```

`build/` (archives + exported `.ipa`) is gitignored.

---

## Human checkpoints, in order

The agent built and tested all the code; these steps need a person, an Apple account, or a device.
Detail + who-does-what is in [`docs/CONNECTIONS.md`](../../../docs/CONNECTIONS.md) (Tier 2).

1. **Apple Developer Program** active (team `UM9HVDH3P3`). Enable on the App ID `com.chartash.still`:
   **App Groups** (`group.com.chartash.still`), **Sign in with Apple**, **In-App Purchase**.
2. **App Store Connect:** create the non-consumable **`still_sync`** ($2.99); generate an **In-App
   Purchase Key (.p8)** and an **App Store Connect API key (.p8)**; add **sandbox testers**.
3. **RevenueCat dashboard:** project + the `still_sync` product + an **entitlement named `still_sync`**
   + an offering containing it; add the webhook (+ static auth token) and upload the IAP `.p8`. The
   public `appl_` key goes in `apps/apple/Still/Config/Secrets.local.xcconfig` (gitignored); the
   secret `sk_` key + webhook token are **Supabase** secrets (`supabase secrets set`), never in the app.
4. **Deploy Phase A to hosted Supabase** (the sync/entitlement backend the app talks to): `supabase db
   push`, `supabase functions deploy`, `supabase secrets set` (RevenueCat keys, webhook token, JWT),
   Resend for magic-link email. Until this is live, sign-in/sync/entitlement can't function end-to-end.
5. **Xcode, once:** open `Still/Still.xcodeproj`, select the team on all 4 targets if prompted, and for
   the Run scheme set **Edit Scheme → Run → Options → StoreKit Configuration → `Still.storekit`** so the
   Simulator/Xcode purchase flow works without App Store Connect.
6. **Sandbox purchase test** on a device (signed into a sandbox tester): buy `still_sync`, confirm the
   local UI unlocks and — via the webhook — sync turns on in a desktop Chromium install on the same
   account.
7. **Submit:** `./archive.sh` → upload → App Store Connect metadata/review. Chrome Web Store submission
   of the Chromium extension is a parallel human checkpoint.

---

## Remaining U19 web integration (do alongside step 4)

The native layer is complete and tested: Sign in with Apple (`Auth/SignInWithApple.swift`), the
RevenueCat `PurchaseManager`, and the `WebBridgeRouter` that exposes `signInWithApple` /
`configurePurchases` / `purchase` / `restore` / `purchaseStatus` to the WebView. The TS client
(`@still/core/native` `NativeBridge`) is implemented and unit-tested. The last mile — best done when
the Supabase backend (step 4) is live, since it can only be verified then — is wiring them into the
shared web UI:

1. **Config:** add `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` to a gitignored `.env` for
   `packages/app-webview` (publishable, client-side keys).
2. **`packages/app-webview/src/main.ts`:** create a Supabase client; build an `AppleAuthPort` whose
   `signIn()` calls `NativeBridge.signInWithApple()` then `supabase.auth.signInWithIdToken({ provider:
   "apple", token, nonce })`; on a session, call `NativeBridge.configurePurchases(uuid)` (KTD5) and run
   the existing tested `SyncService.onSignedIn(uuid)` (reconcile → entitlement → mirror). Wire it into
   `UiController` (inject the auth port; reflect `SyncService` state into `userId`/`entitled`/`reconciling`).
3. **Paywall buy:** on the shared UI's "Get Still Sync" CTA, call `NativeBridge.purchaseStillSync()`;
   on `entitled`, refresh state (sync follows once the webhook lands and the WebView reconciles).
4. **UI:** show a **Sign in with Apple** button instead of the email field when `NativeBridge.available`
   (Apple host only); the Chromium extension keeps the email magic-link path. Gate the buy CTA on a
   signed-in session (KTD5 — no anonymous purchase).
