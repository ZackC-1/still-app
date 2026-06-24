# Still — Phase B status & handoff

The handoff doc for finishing **Still**. Phase A (the Chromium extension, the Supabase backend, the
shared Svelte UI, the test harness) is **complete and merged to `main`**. Phase B (the Apple app +
the paid purchase) is **largely built and merged to `main`** — what's left is the backend-gated last
mile and the human App Store / RevenueCat / Supabase-deploy checkpoints.

The authoritative spec is `docs/plans/2026-06-23-001-feat-still-build-plan.md` (Phase B = units
U17–U20). External/human connections are in `docs/CONNECTIONS.md`. The Apple ship pipeline + the
ordered human checkpoints are in `apps/apple/scripts/README.md`.

---

## ✅ Done (on `main`)

**Phase A — all of it** (PR #2). 139 tests green in CI.

**Phase B — U17, U18, U20 complete; U19 native + contract complete** (PR #3 + the `build/phase-b-2`
follow-up):

- **Scaffold + signing:** Xcode project (`apps/apple/Still`), paid team **`UM9HVDH3P3`**, bundle
  **`com.chartash.still`** (+`.Extension`) on all 4 targets; runs on the registered iPhone (UDID
  `00008150-0012445222F2401C`). macOS floor 11.0 (Safari Web Extension requirement).
- **StillKit** (SwiftPM, tested): `StillSettings`/`StillServices` Codable mirror of the TS shape,
  `SharedSettingsStore` (LWW, App-Group + in-memory), `SettingsBridge`, onboarding `OnboardingGate` +
  `SafariExtensionStatus`. **18 `swift test`.**
- **U17 — WKWebView settings bridge (KTD4):** the app hosts the one shared Svelte UI in a WKWebView,
  persisting through `SettingsBridge` against App Group `group.com.chartash.still`; the Safari
  extension reconciles against the same container. Web bundle inlined to one `index.html`. **Verified
  on-sim:** get→set→get round-trip persists; real UI renders.
- **U18 — onboarding (4 SwiftUI screens):** Welcome → Outcome → Enable → Done, gated once, over
  Settings. macOS reads live extension state via `SFSafariExtensionManager`; iOS is instructional.
  All 4 screens verified on-sim; production gate auto-presents.
- **U19 (native + contract):** `Still.storekit` (`still_sync` $2.99); RevenueCat via SPM (5.79.0);
  `PurchaseManager` (configure-after-sign-in/KTD5, buy/restore/status); `SignInWithApple` coordinator
  + `applesignin` entitlement; `WebBridgeRouter` exposing `signInWithApple`/`configurePurchases`/
  `purchase`/`restore`/`purchaseStatus` to the WebView; public `appl_` key injected via a gitignored
  xcconfig. The TS `@still/core/native` `NativeBridge` client is implemented + **unit-tested** (107
  core tests). All compiles/builds on iOS + macOS.
- **U20 — ship pipeline:** `apps/apple/scripts/{build,test,archive}.sh` + `ExportOptions.plist` +
  `README.md` (the ordered human checkpoints). `build.sh ios-sim` verified green.

---

## ⛏️ Left to do

### U19 — final web integration (backend-gated; do alongside the Supabase deploy)
The native layer + the web↔native contract are done and tested. The last mile is wiring
`NativeBridge` + a Supabase client + the existing tested `SyncService` + the paywall/SIWA UI into
`packages/app-webview/src/main.ts` and the shared UI. It can only be **verified** once the Supabase
backend is live, so it pairs with the deploy. **Exact steps:** `apps/apple/scripts/README.md` →
"Remaining U19 web integration".

### Human checkpoints (none doable by the agent) — ordered in `apps/apple/scripts/README.md`
Apple Developer caps (App Groups + SIWA + IAP on the App ID) · App Store Connect `still_sync` + IAP
`.p8` + ASC API key + sandbox testers · RevenueCat dashboard (entitlement `still_sync` + offering +
webhook; upload the IAP `.p8`) · **deploy Phase A to hosted Supabase** (`db push`, `functions deploy`,
`secrets set`, Resend) · select `Still.storekit` in the Run scheme · on-device sandbox purchase test ·
App Store submit · Chrome Web Store submission (parallel).

### On-device human verification still owed
U18 onboarding tap-through + macOS live extension-state; the full purchase→entitlement→sync loop.

---

## Toolchain & build commands (from `apps/apple/`)
- Everyday: `scripts/build.sh ios-sim` · `scripts/test.sh`
- Signed device: `scripts/build.sh ios-device` then `xcrun devicectl device install app --device <id> <Still.app>`
- Release: `ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=… UPLOAD=1 scripts/archive.sh`
- Swift logic tests: `cd apps/apple/StillKit && swift test`
- Xcode 26.5, Swift 6.3.2. **Quit Xcode before any agent edit to `Still.xcodeproj`** (it's edited via
  the `xcodeproj` Ruby gem; an open Xcode can clobber the change).

---

## Fresh-session kickoff prompt

```
Continue building Still — Phase B. Phase A + Phase B U17/U18/U20 and the U19 native layer + web↔native
contract are COMPLETE and merged to `main`. Read docs/PHASE-B-KICKOFF.md, the build plan
docs/plans/2026-06-23-001-feat-still-build-plan.md (U17–U20), docs/CONNECTIONS.md,
apps/apple/scripts/README.md, and your auto-loaded memories.

Pick up at the U19 final web integration (apps/apple/scripts/README.md → "Remaining U19 web
integration"): wire @still/core/native NativeBridge + a Supabase client + the tested SyncService +
the paywall/Sign-in-with-Apple UI into packages/app-webview/src/main.ts and the shared UI. This pairs
with deploying Phase A to hosted Supabase (human-gated). Then help me through the App Store Connect /
RevenueCat / sandbox-purchase checkpoints.

Work autonomously on a build/* branch: build + swift test + the workspace gate, commit per unit, PR +
merge when green. NEVER claim an App Store / real-purchase / Supabase-deploy step I must do myself.
I'm a first-time Xcode user — give exact click-by-click steps when you need me in Xcode, on my phone,
or in a dashboard. Quit Xcode before editing the .xcodeproj.
```
