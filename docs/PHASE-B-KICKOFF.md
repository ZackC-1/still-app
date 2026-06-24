# Still — Phase B kickoff & status

This is the handoff doc for finishing **Still**. Phase A (the Chromium extension, the Supabase
backend, the shared Svelte UI, and the test harness) is **complete and merged to `main`**. Phase B
(the Apple app + the paid purchase) is **in progress on branch `build/phase-b`**.

The authoritative spec is `docs/plans/2026-06-23-001-feat-still-build-plan.md` (Phase B = units
U17–U20). External/human connections are tracked in `docs/CONNECTIONS.md`.

---

## ✅ Done

**Phase A — all of it, on `main`** (PR #2, merge `6eb418f`). 139 tests green in CI: rule engine,
content script, storage, signed rule-set hosting, magic-link auth + entitlement-gated sync, the
RevenueCat entitlement bridge (faked-payload proven), account delete/export, selector canary, the
loadable Chromium MV3 extension, and the Playwright harness.

**Phase B so far — on `build/phase-b`:**
- Xcode project scaffolded with `safari-web-extension-packager` → `apps/apple/Still/Still.xcodeproj`
  (iOS + macOS app targets + Safari extension targets, Shared code, extension resources *referenced*
  from `packages/ext-safari/dist`).
- Signing fully working: paid team **`UM9HVDH3P3`**, bundle id **`com.chartash.still`** (+`.Extension`),
  set on all 4 targets. macOS + iOS device builds sign successfully.
- The **Still app runs on the registered iPhone** ("Zack's iPhone", iPhone 17 Pro, UDID
  `00008150-0012445222F2401C`, Developer Mode on). Terminal builds install to the phone — no Xcode
  GUI Run needed for routine iteration.
- **StillKit** (`apps/apple/StillKit`, SwiftPM) — the tested shared Swift logic: `StillSettings`
  /`StillServices` Codable mirroring the TS shape, `SharedSettingsStore` (LWW, App-Group + in-memory
  backings). `swift test` → 5 passing.

---

## ⛏️ Left to do (in order) + how to complete

### U17 (remainder) — the real native app UI + storage bridge
The app currently shows the scaffolder's placeholder screen. Replace it with the real Still UI:
1. **Standalone web bundle of the shared UI.** Add a Vite build (in `packages/core` or a small new
   package) that bundles `packages/core/src/ui/App.svelte` into a static `index.html` + assets the
   WKWebView loads from the app bundle. Reuse the existing `UiController`.
2. **`WKWebViewStorageAdapter` (TS)** in `packages/core/src/storage` implementing `StorageAdapter`,
   bridging to native via `window.webkit.messageHandlers.still.postMessage(...)` and a native→web
   callback (`window.__stillApplyRemote`).
3. **Swift WKWebView host** (`apps/apple/Still/Shared (App)`): loads the bundle, registers a
   `WKScriptMessageHandler`, and reads/writes the App Group through `StillKit.SharedSettingsStore`
   (`AppGroupBacking`). Implement the freshness rule from the plan: compare an `updatedAt` token on
   activation and reconcile before applying; show an "Updating… — open Still to sync" state when the
   acknowledged version lags (KTD4).
4. **Wire StillKit into the app target** (add the local SwiftPM package as a dependency; add the
   **App Groups** capability to the app + extension with a shared group id, e.g.
   `group.com.chartash.still`).
5. **Flesh out `packages/ext-safari` entrypoints** to mirror `packages/ext-chromium` (content +
   popup/options importing `@still/core`) so Safari actually blocks; rebuild the safari `dist` and
   re-run the packager with `--rebuild-project` (or just rebuild — resources are referenced).

Verify: `swift test`; iOS Simulator build; install to the phone; the WKWebView shows the settings UI
and a toggle persists via the App Group.

### U18 — guided "enable the Safari extension" onboarding
SwiftUI, four screens (brainstorm copy). Screen 3 is the guided enable flow using
`SFSafariExtensionManager` state detection (reflect enabled/disabled live). Lands on Settings.
Verify on-device (tap through the Safari enable steps once).

### U19 — StoreKit 2 / RevenueCat purchase + entitlement gating + Sign in with Apple
- Add RevenueCat via SPM (`purchases-ios-spm`). Require a Supabase session before the buy CTA;
  `Purchases.configure(appUserID: supabaseUUID)` only after sign-in (KTD5). Gate local UI on RC
  `CustomerInfo`; gate cross-device sync on the Supabase entitlement (already written, U14).
- Add a local `Still.storekit` config and **test the purchase flow in the Simulator** — this needs
  **no** App Store Connect / RevenueCat account.
- **Human-gated for the REAL purchase:** App Store Connect IAP product `still_sync` ($2.99
  non-consumable) + In-App Purchase Key (.p8) + ASC API key + sandbox testers; RevenueCat project +
  entitlement + offering + webhook + upload the .p8. Hand the user a precise checklist.

### U20 — packaging + handoff
`xcodebuild` build/archive/export scripts (`apps/apple/scripts/`) using an ASC API key; a
consolidated list of every human checkpoint and its order. Chrome Web Store submission for the
Chromium extension is a parallel human checkpoint.

### Also: deploy Phase A to hosted Supabase
The backend is built + locally tested but not deployed. When ready: set the narrow
`still_entitlement_writer` role password, `supabase db push`, `supabase functions deploy`,
`supabase secrets set` (RevenueCat keys, webhook token, JWT secret, notify URL), and Resend for
magic-link email. Human-gated. See `docs/CONNECTIONS.md`.

---

## Toolchain & build commands (from `apps/apple/Still`)
- Simulator (no signing): `xcodebuild build -scheme "Still (iOS)" -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO`
- Signed device build + install: `xcodebuild build -scheme "Still (iOS)" -destination 'id=00008150-0012445222F2401C' -allowProvisioningUpdates` then `xcrun devicectl device install app --device B90BED32-E781-5919-9FA9-C8AFCE1D0489 <Still.app>`
- Swift logic tests: `cd apps/apple/StillKit && swift test`
- Xcode 26.5, Swift 6.3.2. When editing the `.xcodeproj`, have the user quit Xcode first.

---

## Fresh-session kickoff prompt

Paste this into a new Claude Code session in this repo:

```
Continue building Still — Phase B (the Apple app). Phase A (Chromium extension + Supabase backend +
shared Svelte UI + tests) is COMPLETE and merged to `main`. Phase B is in progress on branch
`build/phase-b` — check it out first.

Before anything, read: docs/PHASE-B-KICKOFF.md (status + exactly what's left + how), the build plan
docs/plans/2026-06-23-001-feat-still-build-plan.md (units U17–U20), docs/CONNECTIONS.md, and your
auto-loaded project memories (especially "Still Phase B Apple" for the team id, bundle id, registered
iPhone, and exact build commands).

Done in Phase B: Xcode project scaffolded (apps/apple/Still), signing works (paid team UM9HVDH3P3,
bundle com.chartash.still), the app runs on my registered iPhone (UDID 00008150-0012445222F2401C),
and StillKit (tested Swift settings model + store) exists.

Pick up at the U17 remainder: the real WKWebView-hosted UI + App-Group storage bridge + ext-safari
entrypoints, then U18 onboarding, U19 StoreKit/RevenueCat purchase (code + local .storekit Simulator
test; the real purchase needs my App Store Connect + RevenueCat setup — give me a checklist), and U20
packaging + handoff. Also deploy Phase A to hosted Supabase when I say so.

Work autonomously on build/phase-b: write Swift, build + install to my iPhone from the terminal, run
swift test, Simulator-test the UI, commit per unit. NEVER claim to have done an App Store / real-
purchase / deploy step I must do myself. I'm a first-time Xcode user — when you need me in Xcode, on
my phone, or in a browser dashboard, give exact click-by-click steps. Start by reading the kickoff doc.
```
