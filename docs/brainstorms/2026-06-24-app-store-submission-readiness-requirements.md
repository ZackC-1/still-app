# App Store Submission Readiness — Requirements

**Date:** 2026-06-24
**Status:** Ready for planning (`/ce-plan`)
**Scope:** Deep — feature (8 fixes across native Swift, web/Svelte, and Supabase edge functions)
**Source:** Adversarial Codex security + App Store review. All 8 findings verified against the working tree at `main@4e128fb`.

## Problem

The Still app (iOS/macOS Safari-extension app: WKWebView shell + Svelte UI, native SIWA, RevenueCat IAP, Supabase backend) is **not submit-ready**. An adversarial review surfaced 8 issues spanning two failure classes:

1. **App Store rejection risk** — missing Guideline 5.1.1 account-deletion + privacy-policy affordances, and a missing privacy manifest / required-reason API declarations. These are hard rejections, not warnings.
2. **Security & correctness gaps** — the native WKWebView bridge trusts any script in the web view, RevenueCat identity isn't reset on sign-out, purchase outcomes are dropped by the UI, the production signed rule-set path is unwired, a SIWA concurrency race, and incomplete JWT claim validation.

All 8 were confirmed by reading the cited source. This document defines **what** each fix must accomplish and its acceptance criteria. **How** (file layout, exact APIs) is deferred to `/ce-plan`, except where the fix is inherently a technical/architectural decision.

## Goal & Non-Goals

**Goal:** Bring Still to a state where it passes App Store review for the listed guidelines and closes the verified security/correctness gaps — without regressing the existing tested sync/auth/purchase flows.

**Non-goals (explicitly out of scope for this pass):**
- Generating the *actual* production Ed25519 signing keys / publishing a prod-signed rule set to hosted Supabase (P1 #6 is wiring + readiness, not key ceremony — see that section).
- App Store Connect metadata entry (privacy-policy URL in the listing, privacy "nutrition labels" in the portal) — these are portal actions, not code. We make them *reachable in-app* and *declarable*; the human still completes the portal forms.
- Re-architecting the sync engine, RLS model, or the settings bridge.
- The P2 RLS column-exposure note and hardcoded-price note from the earlier review (tracked separately; not in this batch unless trivially co-located).

## Success Criteria

- [ ] Native bridge rejects privileged messages from non-main-frame / non-bundled origins, and blocks navigation away from the bundled web app (P0 #1).
- [ ] Signed-in UI exposes **Delete account** (with confirmation → calls `delete-user` → local sign-out) and an in-app **Privacy policy** link (P0 #2).
- [ ] `PrivacyInfo.xcprivacy` exists on app + extension targets with the UserDefaults required-reason declaration and tracking=false; RevenueCat SDK manifest presence verified (P0 #3).
- [ ] Sign-out resets native RevenueCat identity; privileged purchase/restore/status calls are rejected when no verified user is configured (P1 #4).
- [ ] Paywall surfaces purchased / cancelled / pending / failed / no-offering states instead of dismissing blindly; duplicate taps disabled (P1 #5).
- [ ] Production signed rule-set fetch/verify/cache path is wired into the Safari extension and gated on `PRODUCTION_RULE_SET_KEYS`, with a documented, testable key-population step (P1 #6).
- [ ] Concurrent SIWA `signIn()` calls fail the in-flight request cleanly instead of corrupting the nonce/continuation (P2 #7).
- [ ] JWT verification validates `iss`, `aud`, and authenticated `role` in addition to signature/expiry/`sub` (P2 #8).
- [ ] Full workspace gate stays green: `lint`, `typecheck`, core + ext-safari + StillKit tests, and the web/app builds. New behavior is covered by tests.

---

## The 8 Problems

### P0 #1 — Native bridge trusts any page/script in the WKWebView

**Evidence (verified):**
- `ViewController.swift:43-44` — the `still` message handler is added with `contentWorld: .page` for the whole web view.
- `ViewController.swift:35` sets `navigationDelegate = self`, but the class implements **no** `WKNavigationDelegate` policy method — any navigation is allowed.
- `WebBridgeRouter.swift:38-85` — `handle()` routes privileged kinds (`signInWithApple`, `configurePurchases` with caller-supplied `appUserID`, `purchase`, `restore`, `purchaseStatus`) directly off `message.body`, with no frame/origin/state gate.

**Risk:** If the web view is ever navigated to a remote page, or local content is injected (e.g. a compromised dependency in the bundle), that script can trigger SIWA, bind RevenueCat to an attacker-chosen UUID (IDOR onto another account's entitlement via `configurePurchases`), probe entitlement status, or initiate a purchase.

**What "fixed" looks like:**
1. **Navigation lockdown.** Implement `webView(_:decidePolicyFor:decisionHandler:)` to **cancel** any top-level navigation whose URL is not the bundled `index.html` file URL (allow the initial load + in-page fragment/reload; cancel everything else, including remote `http(s)`). Non-main-frame navigations to remote origins likewise cancelled.
2. **Frame/origin validation.** In `WKScriptMessage` handling, validate `message.frameInfo.isMainFrame` and that the frame's security origin is the bundled file origin before dispatching **privileged** kinds. Settings `get`/`set` may keep their current path but should ride the same guard for consistency.
3. **State gating.** Privileged purchase/restore/status/configurePurchases must be rejected unless the native layer holds validated signed-in state (couples to P1 #4 — the native "current configured user").

**Acceptance:** A unit/integration test (or `BridgeTests` extension) asserts that a message with `isMainFrame == false` or a non-bundled origin is rejected, and that a navigation request to a remote URL returns `.cancel`. Manual: app still loads + functions normally.

---

### P0 #2 — No reachable in-app account deletion or privacy policy link

**Evidence (verified):**
- `App.svelte:99,104` — signed-in states (`not-entitled`, `entitled-syncing`) expose only a **Sign out** link. No delete/export/privacy affordance anywhere in the matrix.
- `strings.ts:42-54` — `auth` strings contain `signOut` but no delete/privacy copy.
- Backend exists and is correct: `supabase/functions/delete-user/handler.ts:17-26` deletes the verified-JWT subject (cascades profile + entitlement), idempotent — but nothing in the app calls it.

**Risk:** Apple Guideline 5.1.1 requires apps that support account creation to offer **in-app account deletion**, and requires a privacy-policy link both in metadata and in-app. This is a hard rejection.

**What "fixed" looks like:**
1. **Account section** in the signed-in UI (`not-entitled` and `entitled-syncing` states) with a **Delete account** action.
2. **Confirmation** step (destructive, irreversible) before deletion — a confirm sheet/dialog, not a single tap.
3. On confirm: call an authenticated `DELETE`/POST to the `delete-user` function with the current session's bearer token, then **sign out locally** and return to the signed-out state. Surface failure (network/permission) rather than silently swallowing.
4. **Privacy policy link** — an in-app affordance (link/button) opening the hosted privacy-policy URL. URL is a config/constant (the human supplies the final URL; a placeholder constant is acceptable for this pass, clearly marked).
5. New `strings.ts` copy for the account/delete/privacy affordances.

**Wiring note (defer detail to plan):** the web layer needs a port to call `delete-user`. The `SupabaseBackendPort` / `SyncService` is the natural home; the controller exposes a `deleteAccount()` action, App.svelte renders it, `main.ts` supplies the implementation. Confirm whether a native bridge round-trip is needed or the web client can call the function URL directly with the session token (it can — Supabase functions accept the user JWT).

**Acceptance:** Controller/UI tests cover: delete action present in signed-in states, confirm-gates the call, success drives sign-out + signed-out state, failure surfaces an error. Privacy link present and points at the configured URL.

---

### P0 #3 — Missing privacy manifest / required-reason API declarations

**Evidence (verified):**
- `SharedSettingsStore.swift:72,77` — uses App Group `UserDefaults(suiteName:)` (a required-reason API: `NSPrivacyAccessedAPICategoryUserDefaults`).
- `Package.resolved:5` — bundles RevenueCat 5.79.0 (a listed third-party SDK requiring a privacy manifest).
- No `PrivacyInfo.xcprivacy` exists anywhere under `apps/apple/` (verified via `find` — zero results).

**Risk:** App Store submissions using these APIs/SDKs without a privacy manifest + required-reason declarations are rejected at upload/review.

**What "fixed" looks like:**
1. Add `PrivacyInfo.xcprivacy` to the **app** target (and the **extension** target if it independently touches required-reason APIs — the App-Group UserDefaults is shared via StillKit, so confirm which targets link it).
2. Declare:
   - `NSPrivacyAccessedAPITypes` → `NSPrivacyAccessedAPICategoryUserDefaults` with the appropriate reason code (`CA92.1` for app-group access shared between the app and its extension).
   - `NSPrivacyTracking` = `false` (we don't track), empty `NSPrivacyTrackingDomains`.
   - `NSPrivacyCollectedDataTypes` — declare what's collected (email via SIWA, user ID, purchase). Reconcile with what the app actually sends to Supabase / RevenueCat.
3. **Verify** RevenueCat 5.79.0 ships its own privacy manifest (it does as of recent versions) — note it in the plan; no action if present.
4. Ensure the `.xcprivacy` files are added to the target's "Copy Bundle Resources" so they ship.

**Acceptance:** `PrivacyInfo.xcprivacy` present and well-formed (valid plist) on the relevant targets; declarations match actual API usage and data flows. Documented in the plan which targets and which reason codes.

---

### P1 #4 — RevenueCat account switching / sign-out identity incomplete

**Evidence (verified):**
- `PurchaseManager.swift:43-56` — `configure(appUserID:)` accepts any non-empty string; on an already-configured instance it `logIn`s to re-key. No tracking of "current user", no `signOut`/`reset`.
- `service.ts:70-73` + `controller.svelte.ts:115-116` — web sign-out only calls Supabase `auth.signOut()` and clears UI state. No native reset.
- `NativeBridge` (bridge.ts) has **no** `signOut` message; `WebBridgeRouter` has no `signOut` case.

**Risk:** After sign-out, the native layer still has the previous RevenueCat identity configured. A malicious/stale bridge caller can query/purchase/restore against the prior account outside UI state; account switching relies on best-effort `logIn`.

**What "fixed" looks like:**
1. **Native sign-out/reset.** Add a `signOut` (or `resetPurchases`) path: `PurchaseManager` tracks the `currentAppUserID`; a reset calls `Purchases.shared.logOut()` (RevenueCat) and clears it.
2. **Bridge wiring.** New `kind: "signOut"` in `NativeMessage` / `NativeBridge.signOut()` / `WebBridgeRouter` case → `PurchaseManager.reset()`.
3. **Reject when no current user.** `purchase`/`restore`/`purchaseStatus`/`configurePurchases` reject (return failed/false) when no verified current user is configured — this is the state gate P0 #1 §3 references.
4. **Couple to Supabase session.** `configurePurchases` should be tied to the verified Supabase session subject (the UUID already comes from `signInWithIdToken`'s user). Web sign-out (`service.ts`/`controller`) calls `bridge.signOut()` when the bridge is available, before/after clearing Supabase state.

**Acceptance:** Swift tests: reset clears configured state; purchase/restore/status return not-entitled/failed after reset. Web tests: `signOut()` invokes the native bridge reset when available; bridge test covers the new `signOut` kind.

---

### P1 #5 — Purchase outcomes ignored by the UI

**Evidence (verified):**
- `PurchaseManager.swift:73-92` returns `.purchased / .cancelled / .pending / .failed(msg)`; the bridge (`bridge.ts`) faithfully returns `{ outcome, entitled, error? }`.
- `main.ts:100-105` — `onGet` ignores everything except `result.entitled`; on anything else it does nothing.
- `App.svelte:113-119` — the paywall's `onGet` calls `onGet?.()` then **immediately** `c.dismissPaywall()`, so the sheet closes regardless of outcome.

**Risk:** Reviewers/users get no visible handling for cancelled, pending (Ask-to-Buy), no-offering, network failure, or failed purchase. Apple Guideline 3.1.1 expects complete, honest IAP UX; a paywall that silently closes on failure reads as broken.

**What "fixed" looks like:**
1. **Keep the sheet open during purchase**; show an in-flight/disabled state; only dismiss on a confirmed `.purchased` (or explicit user dismiss).
2. **Surface each outcome:** pending ("waiting for approval"), cancelled (return to CTA), failed (error + retry), no-offering ("not available right now"). New `strings.ts` copy.
3. **Disable duplicate taps** while a purchase is in flight.
4. **Restore feedback** — `onRestore` should reflect restored/none, not just silently no-op.
5. The purchase outcome must flow from `main.ts` (`bridge.purchaseStillSync()` result) into controller state that `PaywallSheet` / `App.svelte` render.

**Acceptance:** Controller/UI tests: each outcome maps to a distinct visible state; sheet stays open on non-purchased; duplicate tap is a no-op while pending. The full `PurchaseResult` (not just `.entitled`) is consumed.

---

### P1 #6 — Production signed rule-set path not ready

**Evidence (verified):**
- `trusted-keys.ts:12` — `PRODUCTION_RULE_SET_KEYS` is `[]`.
- `0004_seed_rule_set.sql` — Supabase seed is dev-signed with `still-dev-1`.
- `ext-safari/.../content/index.ts:30` — the Safari content script uses the **bundled** `seed` directly (`ruleSet: seed`), never a fetched/cached verified rule set.

**Risk:** Runtime rule updates are either unavailable (extension only ever uses bundled seed) or unverifiable in production (no production trusted keys → a validly-signed prod set would be rejected, and the dev key must never be trusted in prod).

**What "fixed" looks like (scope-bounded — see Non-goals):**
1. **Wire verified fetch/cache into extension startup.** The Safari content script (or its background) should attempt to load the latest **verified** rule set (fetch → signature-verify against trusted keys → cache), falling back to the bundled seed when offline/unverified. The Chromium path's fetch/verify/cache machinery (U12) already exists in core — reuse it; do not duplicate.
2. **Gate on `PRODUCTION_RULE_SET_KEYS`.** Production builds verify against production keys; dev builds against `DEV_RULE_SET_KEYS`. The seed remains the trusted offline floor.
3. **Document + make testable the key-population step.** Provide the script/process to generate the prod Ed25519 keypair and populate `PRODUCTION_RULE_SET_KEYS` + publish a prod-signed `current` set. **Generating the real keys and publishing to hosted Supabase is a human deploy action (Non-goal)** — this pass delivers the wiring + a documented, dry-runnable procedure, with tests proving the verify/cache/fallback path works against a test key.

**Acceptance:** Safari extension exercises fetch→verify→cache→fallback (tested with a test key, mirroring the existing core rule-set tests). With `PRODUCTION_RULE_SET_KEYS` empty, behavior is safe (falls back to bundled seed, never trusts dev key in a prod build). A documented procedure exists for the human to populate prod keys.

---

### P2 #7 — SIWA nonce corrupted by concurrent bridge calls

**Evidence (verified):**
- `SignInWithApple.swift:49-63` — `signIn()` sets `currentNonce` and (inside the continuation block) `self.continuation` without first checking whether a request is already in flight. A second concurrent `signIn()` overwrites both; the first continuation is leaked/never resumed and the nonce sent to Apple no longer matches the awaited continuation.

**Risk:** Concurrent sign-in attempts (double-tap, re-entrant bridge call) corrupt nonce/continuation state — at best a hung promise, at worst a nonce mismatch that fails Supabase verification confusingly.

**What "fixed" looks like:** At the top of `signIn()`, if `continuation != nil` (a request is in flight), throw/return an `inProgress` error instead of overwriting. Pair with the bridge so the web side surfaces it gracefully (it already routes errors). The web side should also guard double-invocation (the button already disables on `authFlow === "sending"`, but the native guard is the correctness backstop).

**Acceptance:** Swift test: a second `signIn()` while one is in flight throws `.inProgress` (or equivalent) and does not disturb the first request's nonce/continuation.

---

### P2 #8 — JWT verification omits issuer/audience/role

**Evidence (verified):**
- `_shared/jwt.ts` — `verifyHs256` (`:56`) and `verifyEs256` (`:187`) check signature + `exp` only; `verifyJwt` dispatches on `alg`. Callers (`delete-user/handler.ts:22`, reconcile, export) then check `isUuid(claims.sub)`. **No** validation of `iss`, `aud`, or `role`.

**Risk:** A signature-valid token from the wrong issuer/audience, or a non-authenticated role (e.g. `anon`), could pass. Defense-in-depth gap: a token minted for a different purpose/project but with the same key material would be accepted.

**What "fixed" looks like:**
1. Extend `verifyJwt` / the verify functions (or add a claims-validation step in the shared layer) to validate expected `iss` (the Supabase project's issuer URL), `aud` (typically `authenticated`), and `role` (`authenticated`) in addition to signature/expiry/sub.
2. Expected values come from config/env (project ref / issuer URL), not hardcoded — fail closed when unset in production, but keep local/test paths working (tests mint HS256 tokens; they must set matching claims).
3. Apply uniformly across all callers (delete-user, reconcile-entitlement, export) since they share `verifyJwt`.

**Acceptance:** `jwt` tests: a token with wrong `iss`/`aud`/`role` is rejected; a correct one passes. Existing edge-function tests updated to mint tokens with the required claims. All consumers covered by the shared change.

---

## Dependencies & Sequencing

- **P0 #1 and P1 #4 are coupled** — the native "current verified user" state gate is shared. Implement #4's state tracking, then #1 consumes it for the privileged-message gate.
- **P0 #2** depends on a new web→backend `deleteAccount` port; independent of the Swift changes.
- **P2 #8** is a shared-layer change touching all three edge-function consumers + their tests — do it as one unit.
- **P0 #3** is config-only (plist) but must reflect the *actual* data flows, so it benefits from being done alongside the identity/purchase review (#4).
- **P1 #6** reuses existing core fetch/verify/cache; lowest coupling to the others.

**Suggested order:** #8 (isolated backend) → #4 → #1 (consumes #4) → #2 → #5 → #7 → #3 (manifest reflects final data flows) → #6.

## Assumptions

1. **Privacy-policy URL** is not yet finalized; we ship a clearly-marked config constant/placeholder and the human swaps the real URL before submission. (Made autonomously — flag for human.)
2. **Production signing keys** are not generated in this pass (Non-goal); we deliver wiring + procedure + tests against a test key.
3. **App Store Connect portal actions** (privacy labels, metadata privacy URL) remain human tasks; code makes them declarable/reachable.
4. RevenueCat 5.79.0 ships its own privacy manifest — to be verified during planning; if absent, escalate.
5. The web client may call the `delete-user` edge function directly with the user's session bearer token (no native round-trip needed), consistent with how the function already authenticates.
6. The "verified current user" for the native gate is the Supabase UUID established via `signInWithIdToken` and passed to `configurePurchases` — the native layer trusts that the web layer only calls it post-session, but adds its own non-empty/format guard and reset-on-sign-out.

## Handoff

Next: `/ce-plan` to turn these 8 problem definitions into an executable, sequenced blueprint with file-level tasks and verification steps for an autonomous coding agent.
