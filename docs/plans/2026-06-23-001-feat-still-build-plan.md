---
title: "feat: Build Still — short-form video remover (extension + Apple app + Supabase)"
type: feat
status: active
date: 2026-06-23
origin: docs/brainstorms/2026-06-23-still-second-pass-requirements.md
---

# feat: Build Still — short-form video remover (extension + Apple app + Supabase)

## Summary

Build Still end to end: a data-driven content script that surgically removes short-form video (YouTube Shorts, Instagram/Facebook Reels, all of TikTok) across Chromium and Safari, a single shared Svelte settings/paywall UI, a Supabase backend (rule hosting, auth, per-user settings, entitlement bridge), and an Apple app that hosts the Safari Web Extension and runs the StoreKit 2 / RevenueCat purchase. The plan is sequenced around one constraint: maximize what an autonomous `/loop` agent can build and verify with **zero Apple credentials**, and batch the unavoidable human-gated Apple/store work into explicit, late checkpoints.

## Problem Frame

The product surface is large (extension × 2 engines + native app + backend + payments), but the value-bearing core is small and the riskiest dependency is operational, not technical: four platforms whose markup changes constantly, and an Apple toolchain that is human- and credential-gated by design. The founder wants Claude to build "as autonomously as possible with no human permission interruptions." That is achievable for ~70% of the work and impossible for the rest — Xcode signing, App Store Connect, IAP product config, and the real sandbox purchase cannot be done unattended. This plan makes that boundary a first-class structural seam (Phase A autonomous, Phase B human-gated) rather than letting the agent discover it mid-loop.

---

## Autonomy boundary (read first)

**Phase A — fully autonomous, CI-green, no Apple credentials.** Monorepo, shared core + rule engine, content script, Chromium extension, the entire Supabase backend including the RevenueCat webhook bridge (verified with a *faked* payload sourced from RevenueCat's published samples — this proves projection logic, not wire-format, which is first confirmed at the U19 checkpoint), and the full test harness. The Chromium extension is runtime-verified via Playwright; the **Safari extension compiles but its runtime is verified only in Phase B** (needs macOS/Xcode). An agent can build, test, and iterate the rest unattended via `/loop`.

**Phase B — human-gated, batched.** The agent writes 100% of the Swift / StoreKit / RevenueCat integration code and a local `.storekit` test config, but a human on a Mac with Apple credentials must: create the App Store Connect IAP product, generate the In-App Purchase Key (.p8) and ASC API key, create sandbox testers, configure RevenueCat, run the Safari `safari-web-extension-packager` + Xcode build/sign, and run the real purchase test. These are the only steps an agent cannot complete; they are checkpoints, not loop work.

The agent must never claim to have performed a Phase B human step (origin: docs/brainstorms/2026-06-23-still-second-pass-requirements.md, Approach assessment).

---

## Requirements

### Blocking core
R1. Short-form surfaces and their navigation entry points are removed across YouTube, Instagram, Facebook, and TikTok on both desktop and mobile web, flash-free for static page chrome, with no broken layouts.
R2. A Shorts URL with a video id redirects to the standard watch page; on a hard navigation no Shorts player paints (network-layer redirect on Chromium), and on an in-app SPA navigation the Shorts surface is removed under the accepted-flash ceiling (KTD2). A Shorts URL with no id shows the Still placeholder.
R3. Direct Instagram/Facebook Reels URLs and every `tiktok.com` page show the Still placeholder.
R4. The content script re-applies rules on SPA route changes (History API + popstate) and via MutationObserver for lazily injected content; every client ships both desktop and mobile selector sets regardless of platform.
R5. Blocking is driven by a versioned JSON rule set; the user-facing control is one master toggle per service; a rules update adds new surfaces under an enabled service immediately and defaults a brand-new service off until enabled.

### Settings & sync
R6. There is one settings set per account (global on/off, four service toggles, per-site pauses); the local on-device cache is always the read path so blocking applies with no network wait.
R7. Free (sync-off) users transmit nothing — local is the only copy; paid (sync-on) users treat the cloud as source of truth, mirrored into the local cache.

### Accounts, purchase, entitlement
R8. Email magic link is the universal cross-platform sign-in; Sign in with Apple is offered only on Apple devices.
R9. "Still Sync" is a single non-consumable StoreKit 2 IAP via RevenueCat; the entitlement is tied to the Still account, and any device signed into that account reads it to enable sync.
R10. In-app account deletion and data export are available (App Store Guideline 5.1.1).
R18. Entitlement state self-heals: a dropped webhook is recovered by a login/restore reconcile, and a pre-login anonymous purchase is aliased to the account.
R19. On hosts with no purchase path (non-Apple desktop), the paywall shows an explanatory state, never a purchasable CTA.

### Rules hosting & ops
R11. The backend hosts the canonical rule set; clients fetch it at runtime, cache it, and fall back to the cached-then-bundled set offline; rule updates reach clients without an app-store resubmission.
R12. A scheduled selector-health canary fetches each service and flags when live markup no longer matches the current selectors.

### Platforms & packaging
R13. The same WebExtension ships as a Chromium MV3 extension (Chrome/Edge/Brave/Arc) and as a Safari Web Extension hosted in one Xcode project with native iOS and macOS targets.
R14. Host permissions are limited to the four service domains (`*://*.youtube.com/*`, `*://*.instagram.com/*`, `*://*.facebook.com/*`, `*://*.tiktok.com/*`), never `<all_urls>`; both stores' privacy disclosures declare zero data collection.

### Autonomy & delivery
R15. Phase A is buildable and CI-testable with zero Apple credentials; the entitlement bridge is verified end to end with a faked RevenueCat payload.
R16. Human-gated Apple/store steps are batched into explicit checkpoints with generated code/config and clear handoff instructions.
R17. The repo is connected to GitHub with a CI workflow, a hands-off `/loop` permission config, and a documented external-service connection checklist.

---

## Key Technical Decisions

KTD1. **Redirect: DNR-primary on Chromium, content-script fallback on Safari.** On Chromium the Shorts→watch redirect is a static `declarativeNetRequestWithHostAccess` rule (network-layer, zero paint — this matches origin D7). On Safari, which does not reliably support `regexSubstitution` redirects, the redirect is a `document_start` content-script `location.replace`. Both engines hook in-app SPA navigations via the History API, `popstate`, AND the Navigation API (`navigation` event), with the MutationObserver owning same-URL cases (e.g. an Instagram Reel opening in a same-URL modal the History hook never sees). The "no paint" guarantee (R2/AE1) holds for hard navigations; an in-app SPA navigation into a Short falls under the accepted-flash ceiling (KTD2), not the no-paint guarantee (research: Apple forums 700769/721258/763505; MDN BCD).

KTD2. **Flash-free is a CSS guarantee, not a JS one.** Static chrome is hidden via the manifest `content_scripts[].css` array at `document_start` (applies before first paint). Dynamically injected feed items are hidden by a pre-emptive *container* CSS rule plus a MutationObserver as best-effort; a transient sub-frame flash on infinite-scroll injection is the accepted ceiling (origin R1; research: Chrome content_scripts manifest docs).

KTD3. **WXT for the build.** One Vite-based config emits Chromium MV3 and Safari resources with per-browser manifests and Svelte support; pass `--mv3` for the Safari build (WXT defaults Safari to MV2). Always build the `dist/` and load that, never source.

KTD4. **One UI, per-host storage adapter — including the Safari bridge.** The shared Svelte UI persists through an injected adapter: `chrome.storage` in the Chromium/Safari extension contexts; `WKScriptMessageHandler` → native Swift → a shared App Group container in the Apple app's WKWebView. On Safari the content script reads `browser.storage`, so app-set settings must reach it: the Safari app-extension target bridges the App Group container to `browser.storage` (the App Group is source of truth on Apple; `browser.storage` mirrors it). "Build once" holds for markup/logic; storage — and this Safari bridge — is the riskiest seam (origin D8).

KTD5. **Entitlement bridge — webhook + reconcile, not webhook-only.** `app_user_id` = the Supabase `auth.users` UUID, set at `Purchases.configure(appUserID:)` after sign-in; a pre-login anonymous purchase is aliased via `Purchases.logIn(uuid)` on first sign-in. RevenueCat → webhook → Supabase Edge Function with `verify_jwt = false`, a **RevenueCat source-IP allowlist gate** followed by a constant-time compare of a static `Authorization` token, an idempotent upsert keyed on the event id (via a **narrow insert/update-only Postgres role**, not the full service-role key; token never logged), resolution of `app_user_id` + `original_app_user_id` + `aliases[]`, and handling of `NON_RENEWING_PURCHASE` / `TRANSFER` / `CANCELLATION`/refund. Because at-least-once delivery can drop, the table is NOT the sole writer: a **reconcile path** (the app posts `customerInfo`, or a reconcile Edge Function queries the RevenueCat REST API by `app_user_id`) writes entitlement on login/restore so a missed webhook self-heals. Credentials use an **In-App Purchase Key (.p8)** — the shared secret is deprecated for StoreKit 2 (research: RevenueCat docs).

KTD6. **Single settings set.** No `scope` enum; one `profiles` row per user; last-write-wins, timestamped (origin D4).

KTD7. **Per-service toggles; surfaces internal.** Four user toggles; surfaces are authoring/QA units grouped under a service; the safety model is per-service, not per-surface (origin D2/D3).

KTD8. **Supabase RLS, explicit; rule sets are signed.** RLS enabled on every table; `rule_sets` public read (`to anon, authenticated using (true)`), no write policy; `entitlements` user-read / service-role-write only; `profiles` user read+write own row; wrap `auth.uid()` in `(select auth.uid())` and index `user_id` (research: Supabase RLS perf docs; CVE-2025-48757). Because clients execute fetched rules against the DOM, each `rule_sets` row carries an **HMAC-SHA256 signature** (signing key never shipped to clients / never readable by the public role); clients verify the signature before swapping a rule set in, so a leaked service-role key alone cannot push a malicious rule set. Aliases resolved in the webhook are never stored in user-readable columns.

KTD9. **Custom SMTP is a launch blocker.** Supabase's built-in auth email is capped at ~2/hour; magic link in production needs Resend (or SMTP) with a verified sending domain (research: Supabase rate-limit docs).

KTD10. **Test strategy.** Pure-TS rule-engine unit tests + Playwright-against-local-HTML-fixtures (`channel: 'chromium'`, persistent context, extension id derived from the service-worker URL) as the autonomous CI gate; a small real-site smoke layer is non-gating (research: Playwright extension docs).

KTD11. **Apple project shape.** Native iOS + native macOS targets sharing SwiftUI and a *referenced* (not copied) web-extension Resources folder produced by `safari-web-extension-packager` (not Mac Catalyst). The build/archive/upload loop is `xcodebuild`-scriptable with an ASC API key; first-run provisioning and store metadata are GUI/human-gated (research: Apple converter docs).

KTD12. **Autonomy posture.** Project-scoped `bypassPermissions` for hands-off `/loop`, with loops run on a dedicated per-task branch. Because a bypass-mode agent can override any *convention*, the real guardrail is server-side: GitHub **branch protection on `main`** (require PR + green CI, no force-push, no direct push) enabled as a Phase 0 checkpoint, so a runaway loop cannot reach `main` or rewrite history even with all local prompts disabled (origin: distinct-branch practice).

---

## High-Level Technical Design

Component topology — one shared core feeding three thin shells and a backend:

```mermaid
flowchart TB
  subgraph core["packages/core (shared TS)"]
    RE[rule engine]
    CS[content script]
    UI[Svelte settings/paywall UI]
    SA[storage adapter iface]
  end
  ST[packages/shared-types]
  core --> ST

  subgraph chromium["packages/ext-chromium (WXT, MV3)"]
    CPOP[popup] --> UI
    COPT[options] --> UI
    CCS[content] --> CS
    CSTORE[chrome.storage adapter] -.implements.-> SA
  end

  subgraph safari["packages/ext-safari (WXT, --mv3)"]
    SRES[web-ext resources] --> CS
    SRES --> UI
  end

  subgraph apple["apps/apple (Xcode: iOS + macOS)"]
    WK[WKWebView host] --> UI
    NATIVE[StoreKit2 / RevenueCat] 
    BRIDGE[App Group storage adapter] -.implements.-> SA
    APPLEHOST[hosts] --> SRES
  end

  subgraph supa["supabase"]
    RS[(rule_sets - public read)]
    PR[(profiles - RLS)]
    EN[(entitlements - service write)]
    WH[edge fn: revenuecat-webhook]
    DEL[edge fn: delete_user / export]
    CANARY[edge fn: selector canary]
  end

  CCS -->|fetch rules| RS
  SRES -->|fetch rules| RS
  UI -->|auth + settings sync| PR
  UI -->|read entitlement| EN
  NATIVE --> RC[RevenueCat]
  RC -->|webhook| WH --> EN
```

Entitlement bridge — how a purchase on iPhone unlocks sync on a desktop Chromium install:

```mermaid
sequenceDiagram
  participant U as User (iOS app)
  participant SB as Supabase Auth
  participant RC as RevenueCat
  participant WH as Edge Fn (webhook)
  participant EN as entitlements table
  participant DX as Desktop Chromium ext
  U->>SB: magic-link sign in → user UUID
  U->>RC: Purchases.configure(appUserID: UUID) + buy still_sync
  RC->>WH: webhook (NON_RENEWING_PURCHASE, static auth header)
  WH->>WH: constant-time token check; resolve aliases[] → UUID; idempotent on event id
  WH->>EN: service-role upsert {user_id: UUID, still_sync: true}
  DX->>SB: magic-link sign in (same UUID)
  DX->>EN: select own row (RLS) → still_sync = true → enable sync
```

---

## Output Structure

```
still-app/
  pnpm-workspace.yaml
  package.json
  .claude/settings.json            # bypassPermissions (Phase 0)
  .github/workflows/ci.yml         # lint + unit + Playwright-on-fixtures
  .env.example
  packages/
    shared-types/                  # rule set, settings, entitlement types
    core/
      src/rules/                   # rule engine
      src/content/                 # content script + redirect + observer
      src/ui/                      # Svelte settings/paywall UI
      src/storage/                 # storage adapter interface
      rules/seed.json              # bundled default rule set
    ext-chromium/                  # WXT entrypoints (popup, options, content, background)
    ext-safari/                    # WXT --mv3 build → resources for Xcode
    ext-firefox/                   # scaffold only (deferred)
  apps/
    apple/                         # Xcode project (Phase B): iOS + macOS targets
  supabase/
    config.toml
    migrations/                    # schema + RLS
    functions/
      revenuecat-webhook/
      delete-user/
      export-user-data/
      selector-canary/
  tests/
    fixtures/                      # recorded HTML per service for Playwright
  docs/
    Still-Spec-v1.md
    brainstorms/2026-06-23-still-second-pass-requirements.md
    plans/2026-06-23-001-feat-still-build-plan.md
    CONNECTIONS.md                 # external-service checklist (Phase 0)
```

The tree is a scope declaration; the per-unit Files lists are authoritative.

---

## Implementation Units

### Phase 0 — Connections, repo, and autonomy config

### U1. GitHub repository, remote, and CI skeleton
**Goal:** Connect the repo to GitHub, establish the branch model, and stand up a CI workflow that the autonomous loop's commits run against.
**Requirements:** R17.
**Dependencies:** none.
**Files:** `.github/workflows/ci.yml`, `.gitignore`, `README.md`, `docs/CONNECTIONS.md` (CI section).
**Approach:** Create a private GitHub repo (human provides auth/`gh login`; agent runs `gh repo create` once authed) and push `main`. Branch model: all `/loop` work on a dedicated `build/<task>` branch, PR to `main`. **Enable GitHub branch protection on `main`** (require PR + green CI, block force-push and direct push) via the GitHub API as a Phase 0 checkpoint — this is the enforceable guardrail behind the bypass posture (KTD12). CI runs lint + typecheck + rule-engine unit tests + Playwright-on-fixtures on every push; it must be green before merge. No deploy steps in CI yet (Supabase/Apple deploys are human-gated).
**Patterns to follow:** standard pnpm + Playwright GitHub Actions matrix.
**Test scenarios:** Test expectation: none — CI config; validated by the first green run on a throwaway commit.
**Verification:** `gh repo view` resolves; a pushed branch triggers a CI run that passes on the scaffold.

### U2. Claude Code autonomy config for hands-off `/loop`
**Goal:** Configure project-scoped permissions so `/loop` runs without prompts, with blast radius contained to the repo and a dedicated branch.
**Requirements:** R17.
**Dependencies:** U1.
**Files:** `.claude/settings.json`.
**Approach:** Set `defaultMode: bypassPermissions` in project `.claude/settings.json` (per the founder's chosen posture). Contain blast radius by convention, documented in `docs/CONNECTIONS.md`: run loops only on a `build/*` branch; the working dir is the repo; no global settings change. Note the explicit tradeoff in the file's comment block — bypass removes all guardrails, so destructive commands run unattended.
**Patterns to follow:** Claude Code settings.json schema (use the `update-config` skill if adjusting later).
**Test scenarios:** Test expectation: none — config; validated by a no-prompt tool call in a subsequent loop.
**Verification:** A subsequent agent run executes Bash/Edit without a permission prompt; settings are project-scoped (not in `~/.claude`).

### U3. Environment & secrets scaffolding + connection checklist
**Goal:** Create the config surface the agent fills once humans connect services, and document every external connection in one place.
**Requirements:** R17, R16.
**Dependencies:** U1.
**Files:** `.env.example`, `supabase/config.toml`, `docs/CONNECTIONS.md`.
**Approach:** Enumerate every secret as a named, empty `.env.example` key (Supabase URL/anon/service-role, RevenueCat public/secret keys + webhook token, Resend API key + sender domain, Sentry DSN). `docs/CONNECTIONS.md` is the human checklist (see the External Services section of this plan) marking who connects what and when it blocks. `supabase/config.toml` declares `[functions.revenuecat-webhook] verify_jwt = false`.
**Patterns to follow:** Supabase `config.toml` function-auth pattern.
**Test scenarios:** Test expectation: none — scaffolding.
**Verification:** `.env.example` lists every secret referenced anywhere in the codebase; no real secret is committed.

---

### Phase A — Autonomous build (no Apple credentials; CI-green)

### U4. Monorepo scaffold + WXT + tooling
**Goal:** Stand up the pnpm workspace, WXT, TypeScript, lint/format, and the empty package boundaries.
**Requirements:** R13, R15.
**Dependencies:** U1.
**Files:** `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `packages/shared-types/package.json`, `packages/core/package.json`, `packages/ext-chromium/wxt.config.ts`, `packages/ext-safari/wxt.config.ts`, `packages/ext-firefox/.gitkeep`.
**Approach:** `core` and `shared-types` are libraries consumed via `workspace:*`. `ext-chromium` and `ext-safari` are WXT projects targeting the same entrypoints; Safari config passes `--mv3`. Firefox is a scaffold-only folder (deferred).
**Patterns to follow:** WXT monorepo + pnpm `workspace:*` deps.
**Test scenarios:** Test expectation: none — scaffolding; a `wxt build` smoke produces a `dist/` for both targets.
**Verification:** `pnpm -r build` succeeds; both extension `dist/` folders are produced.

### U5. Rule-set schema + seed rule set (four services)
**Goal:** Define the versioned rule-set type and a hand-authored seed set covering every surface in spec Sections 4.1–4.4.
**Requirements:** R5, R11.
**Dependencies:** U4.
**Files:** `packages/shared-types/src/rules.ts`, `packages/core/rules/seed.json`, `packages/shared-types/src/settings.ts`, `packages/shared-types/src/entitlement.ts`.
**Approach:** Schema: `{ version, services: { [id]: { matches[], surfaces: [{ id, label, action, selectors[], redirect?, enabledByDefault }] } } }`. Actions: `hide`, `remove`, `redirect`, `placeholder`, `blockSite`. Seed includes YouTube (sidebar, home shelf, search, subscriptions, channel tab, chips, redirect), Instagram (nav, inline, explore, search, suggested, profile tab, placeholder), TikTok (`blockSite`), Facebook (feed, left menu, watch, search, groups, suggested, placeholder). Include both desktop and `m.`/mobile selectors (R4).
**Patterns to follow:** the rule-set shape in spec Section 4.5.
**Test scenarios:** Schema validation: a well-formed seed parses; a malformed set (missing `version`, unknown `action`) is rejected. Each service has at least one surface and a `matches` pattern. `blockSite` is only on TikTok.
**Verification:** A schema validator accepts `seed.json`; unit tests assert per-service surface coverage.

### U6. Rule engine (pure TS)
**Goal:** The framework-agnostic engine that, given a rule set + settings + a DOM, applies hide/remove/placeholder/blockSite and computes redirects.
**Requirements:** R1, R3, R5.
**Dependencies:** U5.
**Files:** `packages/core/src/rules/engine.ts`, `packages/core/src/rules/match.ts`, `packages/core/src/rules/__tests__/engine.test.ts`.
**Approach:** Pure functions over a DOM (jsdom-testable): resolve which service matches a URL, filter surfaces by the per-service toggle (KTD7), apply actions. `placeholder`/`blockSite` swap document body for the Still placeholder. Redirect computation returns a target URL or null (no DOM side effects here — the content script performs navigation). Generate the CSS string for `hide` surfaces for the manifest-CSS path (KTD2).
**Patterns to follow:** keep DOM mutation injectable so the engine is unit-testable without a browser.
**Test scenarios:** `youtube.com/shorts/abc` → redirect target `…/watch?v=abc` (Covers AE1); `youtube.com/shorts/` (no id) → placeholder (Covers AE2); a disabled service toggle → no surfaces applied; an unknown URL → no-op; a `tiktok.com` URL → blockSite/placeholder; new surface under an enabled service applies, brand-new service stays off (Covers AE4); generated CSS hides the expected selectors.
**Verification:** Unit tests green in jsdom across all four services and the toggle matrix.

### U7. Content script — injection, redirect, SPA + observer
**Goal:** The `document_start` content script that wires the engine to a live page flash-free, handles SPA navigation, and performs the Shorts redirect.
**Requirements:** R1, R2, R4.
**Dependencies:** U6.
**Files:** `packages/core/src/content/index.ts`, `packages/core/src/content/redirect.ts`, `packages/core/src/content/observer.ts`, `packages/core/src/content/__tests__/redirect.test.ts`, `packages/core/src/content/__tests__/observer.test.ts`.
**Approach:** Static-chrome CSS is shipped via the manifest `content_scripts[].css` (assembled from U6) so it applies pre-paint (KTD2). The script reads settings from a **synchronous in-memory snapshot** hydrated from the storage adapter (U8) — it never awaits the adapter on the injection path. Redirect (KTD1): Chromium relies on the static DNR rule (U10) for hard-nav; Safari uses a `document_start` `location.replace`. Both hook in-app navigations via History API (`pushState`/`replaceState`/`popstate`) AND the Navigation API (`navigation` event); the MutationObserver (rAF-coalesced) owns same-URL cases (e.g. a Reel opening in a same-URL modal) plus lazily injected feed items, with pre-emptive container CSS to minimize flash.
**Execution note:** Start with a failing test for the redirect URL transform and the History-hook re-fire.
**Test scenarios:** Chromium hard-nav Shorts URL with id → DNR redirect, no paint; Safari hard-nav → `location.replace` redirect; History pushState into a Short re-fires; Navigation-API route change re-fires; popstate back out does not loop; same-URL Reel modal is caught by the observer (no URL change); observer removes a feed item injected after load and disconnects on teardown; no redirect when id absent (→ placeholder path); content script never awaits the adapter at document_start (reads the snapshot). Covers AE1, AE2.
**Verification:** jsdom + fake-DOM tests green; Playwright fixture test (U16) confirms flash-free static hide.

### U8. Settings model + per-host storage adapter
**Goal:** The single-settings-set model, the local cache that the content script reads, and the storage-adapter interface with the extension implementation.
**Requirements:** R6, R7.
**Dependencies:** U4.
**Files:** `packages/core/src/storage/adapter.ts`, `packages/core/src/storage/chrome-adapter.ts`, `packages/core/src/storage/cache.ts`, `packages/core/src/storage/__tests__/cache.test.ts`.
**Approach:** Adapter interface: `get()/set()/subscribe()` (all async). `chrome-adapter` uses `chrome.storage.local`. The content script never reads the adapter directly on the injection path — it reads a **synchronous in-memory snapshot** hydrated from the adapter at startup, with the bundled defaults applied for the pre-hydration window. Settings shape: `{ globalOn, services: {yt,ig,tt,fb: boolean}, pauses: string[], updatedAt }` — one set, no scope (KTD6). Per-site pause key is the eTLD+1 (e.g. `youtube.com`). Writes update the snapshot + adapter immediately, then (when sync on) push to Supabase. The WKWebView/App-Group adapter is U17 (Phase B).
**Patterns to follow:** storage-abstraction so the same UI runs in three hosts (KTD4).
**Test scenarios:** write-then-read round-trips; subscribe fires on change; per-site pause add/remove; LWW resolves a stale write by `updatedAt`; free-user write never calls the network (Covers AE6); paused site short-circuits engine application (Covers AE5).
**Verification:** Unit tests green; chrome-adapter validated in the Playwright harness.

### U9. Shared settings/paywall web UI (Svelte)
**Goal:** Build the one UI: global toggle, four service cards, per-site pause, sync/account section, paywall sheet, Still placeholder, light/dark tokens, drafted copy.
**Requirements:** R6, R8, R9, R14 (UI strings), R1 (placeholder).
**Dependencies:** U8.
**Files:** `packages/core/src/ui/App.svelte`, `packages/core/src/ui/components/*.svelte` (Toggle, SettingsRow, ServiceCard, PaywallSheet, Placeholder), `packages/core/src/ui/tokens.css`, `packages/core/src/ui/strings.ts`, `packages/core/src/ui/__tests__/App.test.ts`.
**Approach:** Tokens from spec Section 3.3 (Still Blue `#2A47E8` working value — see Open Questions). Sentence case, outcome-phrased copy from the brainstorm's drafted-copy section. The UI talks only to the injected storage adapter + an auth/sync client (U13); it is host-agnostic. The UI specifies behavior per state (a **UI state matrix**), not just the component inventory: popup (signed-out / signed-in-not-entitled / entitled-syncing / cloud-unreachable); magic-link sign-in (idle → sending → check-your-email → error, with a resend cooldown); paywall (dismiss leaves a persistent "Get Still Sync" row; the full sheet only re-opens on tap); settings signed-out empty state; per-site pause (button toggles Pause/Resume by current-site state); a one-time "your settings now match your other devices" notice on first cloud sync; and the Still placeholder (one string across the Shorts-no-id / Reels / TikTok contexts). **On non-Apple hosts the paywall renders an explanatory state** ("buy once on iPhone, iPad, or Mac — sync turns on here when you sign in"), never a purchasable CTA (R19). Full light/dark, keyboard-reachable controls, and a focus-trapped paywall sheet.
**Patterns to follow:** brainstorm drafted copy; design tokens in spec Section 3.
**Test scenarios:** toggling a service card writes the right settings key; global off disables all; paywall shows unlock when not entitled, account state when entitled; light/dark follows `prefers-color-scheme`; placeholder renders glyph + one calm line, no buttons.
**Verification:** Component tests green; visual check in the Chromium options page (U10).

### U10. Chromium extension assembly (WXT MV3)
**Goal:** Wire core into a loadable MV3 extension: popup, options page, content-script registration, manifest, host permissions, optional static DNR redirect rule.
**Requirements:** R13, R14, R1, R2.
**Dependencies:** U7, U9.
**Files:** `packages/ext-chromium/entrypoints/popup/*`, `packages/ext-chromium/entrypoints/options/*`, `packages/ext-chromium/entrypoints/content.ts`, `packages/ext-chromium/entrypoints/background.ts`, `packages/ext-chromium/wxt.config.ts`, `packages/ext-chromium/rules/dnr-youtube.json`.
**Approach:** Popup = global on/off + pause-here + open options + state-at-a-glance, rendering the popup state matrix from U9 (signed-out / not-entitled / entitled / offline; pause button reads Pause vs Resume by current-site state). Options = the full shared UI. Content entrypoint imports core's content script; manifest `css` assembled from the rule set; `matches`/`host_permissions` = the four domains (R14). The static `declarativeNetRequestWithHostAccess` Shorts redirect rule is the **primary** redirect path on Chromium (KTD1); the content-script redirect is the Safari path.
**Patterns to follow:** WXT entrypoints; manifest content_scripts CSS at document_start.
**Test scenarios:** extension loads unpacked in Playwright; service worker registers; options page renders the UI; popup pause toggles per-site state; host permissions exactly the four domains; no `<all_urls>`.
**Verification:** Playwright loads `dist/`, derives the extension id from the SW URL, asserts UI + permissions (U16).

### U11. Supabase schema + RLS migrations
**Goal:** Create `profiles`, `entitlements`, `rule_sets` with correct RLS and indexes. (`devices` is dropped from v1 — no consumer under the single-settings model; defer to a future migration if per-device tracking is ever needed.)
**Requirements:** R6, R7, R9, R11, R14.
**Dependencies:** U3, U5.
**Files:** `supabase/migrations/0001_init.sql`, `supabase/migrations/0002_rls.sql`, `supabase/migrations/0003_indexes.sql`.
**Approach:** `profiles(id uuid pk→auth.users, settings jsonb, updated_at)` — one row per user, no scope (KTD6). `entitlements(user_id uuid pk→auth.users, still_sync bool, source text, updated_at)`. `rule_sets(version text pk, payload jsonb, is_current bool, published_at)`. RLS per KTD8: enable on all; `rule_sets` public read, no write; `entitlements` user read-only / service-role write; `profiles` user read+write own; `(select auth.uid())` wrapping; index `entitlements.user_id`, `profiles.id`. `on delete cascade` FKs to `auth.users` for U15.
**Patterns to follow:** Supabase RLS perf best practices (research).
**Test scenarios:** anon can select `rule_sets`, cannot insert; user A `SELECT ... WHERE user_id = <B>` returns zero rows (no cross-user read, no UUID enumeration); resolved aliases are not stored in any user-readable column; user cannot write own entitlement; service role can; cascade delete removes profile + entitlement rows.
**Verification:** Migrations apply on local Supabase (CLI/Docker); RLS asserted via the local test suite against anon + two user JWTs.

### U12. Rule-set hosting + runtime fetch with bundled fallback
**Goal:** Serve the current rule set publicly and have every client fetch-with-fallback at runtime.
**Requirements:** R11.
**Dependencies:** U6, U11.
**Files:** `packages/core/src/rules/fetch.ts`, `packages/core/src/rules/fetch.test.ts`, `supabase/migrations/0004_seed_rule_set.sql`.
**Approach:** Client fetches the `is_current` rule set with a short timeout, schema-validates and size-caps it, swaps only on a newer well-formed version, caches to storage; on failure uses cache → bundled `seed.json`. Seed migration publishes the U5 seed as `is_current`.
**Test scenarios:** offline → bundled set used (Covers AE3); fetch newer valid version → swap + cache; fetch malformed → keep last good; fetch older version → ignore; oversized payload → reject.
**Verification:** Unit tests with mocked fetch green; integration against local Supabase returns the seeded set.

### U13. Auth (magic link) + settings sync
**Goal:** Magic-link sign-in, profile read/write sync, and local-cache mirroring gated by the entitlement.
**Requirements:** R6, R7, R8.
**Dependencies:** U8, U11.
**Files:** `packages/core/src/sync/auth.ts`, `packages/core/src/sync/profile.ts`, `packages/core/src/sync/__tests__/sync.test.ts`.
**Approach:** Supabase JS client; magic-link sign-in returns the user UUID (used later as RevenueCat `app_user_id`). When entitled + signed in: cloud `profiles.settings` is source of truth, mirrored to local cache; edits write cloud + cache (LWW). When not entitled or signed out: local only (R7). SIWA is wired in the Apple app only (U19).
**Test scenarios:** sign-in stores session; entitled user's cloud settings overwrite local on load; edit writes both; sign-out reverts to local-only; un-entitled signed-in user does NOT sync (gating); concurrent edits resolve by `updatedAt`.
**Verification:** Tests against local Supabase with two sessions; sync path proven without Apple.

### U14. RevenueCat webhook Edge Function (entitlement bridge)
**Goal:** Receive RevenueCat webhooks and project entitlement state onto the Supabase user — the keystone of the cross-device unlock, verified with a faked payload.
**Requirements:** R9, R15.
**Dependencies:** U11.
**Files:** `supabase/functions/revenuecat-webhook/index.ts`, `supabase/functions/revenuecat-webhook/__tests__/webhook.test.ts`.
**Approach:** Per KTD5: RevenueCat source-IP allowlist gate, then `verify_jwt=false` + constant-time compare incoming `Authorization` vs `REVENUECAT_WEBHOOK_TOKEN` (via a narrow insert/update-only Postgres role, not full service-role; token never logged); resolve `app_user_id`/`original_app_user_id`/`aliases[]` to the Supabase UUID; idempotent upsert keyed on event id; map `NON_RENEWING_PURCHASE`→grant, `TRANSFER`→move, `CANCELLATION`/refund→revoke; 401 on bad token, 403 on non-allowlisted IP, 200 on duplicate. Also expose a **reconcile** path (`reconcile-entitlement` queries the RevenueCat REST API by `app_user_id`) so a dropped webhook self-heals on next login/restore.
**Execution note:** Test-first against faked RevenueCat payloads — this path must be provable with zero Apple involvement (R15).
**Test scenarios:** valid grant payload → entitlement true; bad token → 401, no write; request from a non-allowlisted IP → 403, no write; duplicate event id → single row (idempotent); `TRANSFER` moves entitlement between UUIDs; `CANCELLATION` revokes; alias-only `app_user_id` resolves to the canonical UUID; webhook dropped then login → reconcile path writes entitlement true; malformed body → 4xx.
**Verification:** Local function test POSTs faked payloads with the right/wrong token and asserts `entitlements` state end to end.

### U15. Account deletion + data export Edge Functions
**Goal:** In-app account deletion and data export for App Store 5.1.1 / GDPR.
**Requirements:** R10.
**Dependencies:** U11.
**Files:** `supabase/functions/delete-user/index.ts`, `supabase/functions/export-user-data/index.ts`, `supabase/functions/__tests__/account.test.ts`.
**Approach:** `delete-user` (service role) deletes the `auth.users` row; `on delete cascade` removes profile + entitlement. `export-user-data` returns the user's profile + entitlement as JSON. Document that the Apple purchase record persists with Apple/RevenueCat (restore re-links on re-signup).
**Test scenarios:** delete removes profile + entitlement (cascade); delete is idempotent; export returns only the caller's data; unauthenticated calls rejected.
**Verification:** Local function tests green against local Supabase.

### U16. Test harness — unit + Playwright-on-fixtures + smoke + CI
**Goal:** The autonomous test gate: rule-engine unit tests, content-script DOM assertions against recorded fixtures, a non-gating real-site smoke, all wired into CI.
**Requirements:** R15, R1.
**Dependencies:** U7, U10.
**Files:** `tests/fixtures/{youtube,instagram,facebook,tiktok}.html`, `tests/playwright/extension.spec.ts`, `tests/playwright/fixtures.spec.ts`, `tests/smoke/real-sites.spec.ts`, `playwright.config.ts`, `.github/workflows/ci.yml` (extend).
**Approach:** Per KTD10: Playwright `launchPersistentContext({ channel: 'chromium', args: [--load-extension] })`, derive id from the SW URL, serve recorded HTML fixtures locally, assert target nodes removed + static chrome hidden flash-free. Real-site smoke is a separate, retry-allowed, non-gating job. Capture fixtures from saved page HTML (recorded once; refreshed when selectors break).
**Test scenarios:** each service fixture: target surfaces removed, page otherwise intact; Shorts fixture: redirect attempted; static chrome hidden before first paint (no flash); smoke job runs but never gates merge.
**Verification:** CI green on fixtures; smoke job reports separately.

### U21. Selector-health canary Edge Function
**Goal:** The scheduled canary that fetches each service and flags when live markup no longer matches the current selectors — the operational early-warning for selector rot (origin D10: a requirement, not optional).
**Requirements:** R12.
**Dependencies:** U5, U11, U12.
**Files:** `supabase/functions/selector-canary/index.ts`, `supabase/functions/selector-canary/__tests__/canary.test.ts`.
**Approach:** A scheduled function (Supabase cron) fetches each service's representative page, runs the current rule set's selectors against the fetched HTML, and counts matches per surface. Zero matches for a previously-matching surface → flag. Emit one outbound notification (a webhook/email URL stored as an env secret) naming the broken service + surface. Elaborate routing/dashboards are follow-up, but a minimal alert ships in v1.
**Test scenarios:** a fixture whose markup matches → no flag; a fixture with a renamed selector → flag naming the surface; notification fires once per newly-broken surface; missing notify secret → logs and no-ops without crashing.
**Verification:** Local function test flags a deliberately-broken fixture and fires a mock notification.

---

### Phase B — Human-gated Apple/store (agent writes code; human runs Apple gates)

### U17. Apple Xcode project — iOS + macOS, Safari ext host, WKWebView + storage bridge
**Goal:** Generate the single Xcode project with native iOS + macOS targets that host the Safari Web Extension and the shared UI, including the App-Group storage adapter.
**Requirements:** R13, R6, R10 (delete entry).
**Dependencies:** U4 (produces the ext-safari `dist/`), U9.
**Files:** `apps/apple/Still.xcodeproj`, `apps/apple/Shared/*.swift`, `apps/apple/iOS/*.swift`, `apps/apple/macOS/*.swift`, `apps/apple/Shared/StorageBridge.swift`, `docs/CONNECTIONS.md` (Apple build section).
**Approach:** Run `xcrun safari-web-extension-packager` against `packages/ext-safari` `dist/` to scaffold native iOS + macOS targets sharing a *referenced* Resources folder (KTD11). WKWebView hosts the shared UI; `WKScriptMessageHandler` ↔ native ↔ App Group container implements the storage adapter (KTD4) and exposes account-deletion. **Human checkpoint:** first-run signing/provisioning in Xcode.
**Test scenarios:** Test expectation: limited — Swift unit test for the storage bridge encode/decode; full validation is the human Xcode build (checkpoint).
**Verification:** Project opens and builds in Xcode (human); the WKWebView loads the shared UI and round-trips a setting through the App Group.

### U18. Guided "enable the Safari extension" onboarding
**Goal:** The illustrated walkthrough + live detection of whether the Safari extension is enabled.
**Requirements:** R13.
**Dependencies:** U17.
**Files:** `apps/apple/Shared/Onboarding/*.swift`.
**Approach:** Four onboarding screens (brainstorm drafted copy); screen 3 is the guided enable-extension flow with `SFSafariExtensionManager`/state detection reflecting enabled/disabled. Lands on Settings when done.
**Test scenarios:** Test expectation: limited — state-detection logic unit-tested where possible; UX validated on-device (human).
**Verification:** On-device, the onboarding reflects real extension state (human checkpoint).

### U19. StoreKit 2 / RevenueCat purchase + entitlement gating + SIWA
**Goal:** The native purchase flow, `.storekit` local test config, entitlement gating, and Sign in with Apple.
**Requirements:** R8, R9.
**Dependencies:** U13, U14, U17.
**Files:** `apps/apple/Shared/Purchases/*.swift`, `apps/apple/Still.storekit`, `apps/apple/Shared/Auth/SignInWithApple.swift`.
**Approach:** RevenueCat via SPM (`purchases-ios-spm`); `Purchases.configure(appUserID: supabaseUUID)` after sign-in, and `Purchases.logIn(supabaseUUID)` to alias any pre-login anonymous purchase (KTD5); the paywall buy action is gated on an active session (no anonymous purchase in the shipped UI); after purchase/restore the app posts `customerInfo` to the reconcile path (U14) so the entitlement lands even if the webhook drops; gate sync on `customerInfo.entitlements["still_sync"].isActive`; visible restore button; a local `.storekit` config lets purchase flows be exercised without App Store Connect. **Human checkpoints:** ASC product creation, .p8 key, sandbox testers, RevenueCat dashboard, real purchase test.
**Test scenarios:** Test expectation: limited — purchase/entitlement logic exercised against the local `.storekit` config (human runs in Xcode); restore re-links to the current UUID. The webhook→entitlement projection is already proven in U14 without Apple.
**Verification:** Sandbox purchase unlocks sync on the device and, via the webhook, on a desktop Chromium install signed into the same account (human checkpoint).

### U20. Safari packaging + build/sign pipeline + handoff doc
**Goal:** Scriptable build/archive/upload pipeline and the consolidated human-checkpoint handoff.
**Requirements:** R16.
**Dependencies:** U17, U19.
**Files:** `apps/apple/scripts/build.sh`, `apps/apple/scripts/archive.sh`, `docs/CONNECTIONS.md` (store-submission section).
**Approach:** `xcodebuild` scripts for build/archive/export using an ASC API key (the recurring loop is scriptable; first-run provisioning + store metadata are GUI). Handoff doc enumerates the exact human steps and the order. Chrome Web Store submission for the Chromium extension is a parallel human checkpoint.
**Test scenarios:** Test expectation: none — pipeline scripts; validated by a human archive run.
**Verification:** Scripts produce a signed archive given valid credentials (human); handoff doc lists every gate.

---

## Scope Boundaries

**Deferred for later (planned, not v1):** Firefox add-on (scaffold only); Android; Stripe / web checkout; whole-app native blocking (Screen Time / VPN); per-device settings profiles; a usage counter; behavioral analytics.

**Outside this product's identity:** whole-site blocking of anything except TikTok; timers / streaks / locks / willpower mechanics; ad-blocking; parental controls; de-infinite-ing the regular (non-short-form) feeds; short-form on Google Search/Video results and third-party TikTok/Reel embeds (Still runs only on the four service domains).

**Deferred to follow-up work (this build, separate sequencing):** Sentry beyond DSN wiring; a marketing site / privacy-policy hosting; CDN caching in front of `rule_sets`; elaborate selector-canary routing/dashboards (a minimal alert ships in U21; richer alerting is follow-up).

---

## Risks & Dependencies

- **Selector rot (highest ongoing risk).** Four adversarial platforms change markup constantly; the rule set + canary (R12) + fixture refresh are the mitigation, but this is perpetual operational cost, not one-time (origin: Approach assessment).
- **Custom SMTP is a launch blocker (R8/KTD9).** Without Resend + a verified domain, magic links cap at ~2/hour and land in spam. Schedule early.
- **Apple human gates block Phase B only.** Phase A must stay fully green and shippable (desktop) independent of any Apple step (R15). Do not let Phase B work creep into Phase A's loop.
- **bypassPermissions blast radius.** No guardrails on commands; mitigated only by branch + repo scoping (KTD12). A bad loop can still rewrite the repo — keep `main` protected and loops on `build/*`.
- **WXT Safari defaults to MV2.** Must pass `--mv3` and verify `declarativeNetRequest`/`scripting` behavior on Safari (KTD3); the content-script redirect (KTD1) is the safety net.
- **Buy-before-login orphaned entitlement.** Anonymous purchase must be reconciled via `aliases[]` + reconcile-on-login (KTD5); covered in U14 tests.

---

## External Services & Connections (human checklist)

Lives in `docs/CONNECTIONS.md`; summarized here. "Blocks" = which phase cannot complete without it.

| Service | Why | Who connects | Provides | Blocks |
|---|---|---|---|---|
| GitHub | version control, CI, the autonomous loop's remote | human (`gh auth login`) | repo + Actions | Phase 0 |
| Supabase project | Postgres, Auth, Realtime, Edge Functions, rule hosting | human creates project | URL, anon key, service-role key | Phase A deploy (local dev unblocked via CLI/Docker) |
| Resend (or SMTP) | production magic-link email | human + DNS | API key, verified sender domain | sync launch (R8) |
| Sentry | crash reporting | human | DSN | optional |
| Apple Developer Program ($99/yr) | app, Safari ext, SIWA, IAP | human | team, certs, entitlements | Phase B |
| App Store Connect | IAP product "Still Sync", In-App Purchase Key (.p8), ASC API key, sandbox testers, submission | human | product, .p8, API key | Phase B purchase |
| RevenueCat | entitlement management + webhook | human (dashboard) | public/secret keys, webhook token | Phase B purchase (webhook testable with faked payload in Phase A) |
| Chrome Web Store ($5 one-time) | publish the Chromium extension | human | developer account | Chromium store launch |
| Domain | rule endpoint alias, privacy policy, marketing | human | DNS | optional v1 |
| Mac + Xcode + Apple device(s) | Safari build/sign, sandbox purchase test | human | local toolchain | Phase B |

Local development needs: Node + pnpm, the Supabase CLI + Docker (local Postgres/functions), Playwright (Chromium channel), and `gh`. All agent-installable.

---

## Open Questions

**Resolve before Phase B (human/asset):**
- Canonical Still Blue hex from the founder's source asset (working value `#2A47E8`; swap one token).
- Legal entity for the Apple account (individual vs company) — gates App Store Connect setup.

**Deferred to implementation:**
- Exact per-service selectors and locale-subdomain match list (authored in U5, refreshed against live markup; verified by U16 fixtures).
- The Safari content-script redirect timing vs YouTube's own `document_start` boot (KTD1 fallback path) — verify the race on-device in Phase B.

**Product sequencing (from review — decide before committing Phase B):**
- Ship the Chromium extension to the Chrome Web Store as a standalone free launch at the end of Phase A to validate desktop demand before the perpetual Apple/Safari + selector-maintenance investment? The full free desktop product exists at the Phase A boundary; the plan currently builds both halves before any user contact.

---

## Sources & Research

- Origin requirements: `docs/brainstorms/2026-06-23-still-second-pass-requirements.md`; product spec: `docs/Still-Spec-v1.md`.
- MV3 `declarativeNetRequest` redirect shape + `declarativeNetRequestWithHostAccess`: developer.chrome.com declarativeNetRequest reference; MDN.
- Safari DNR redirect gaps (`regexSubstitution` unsupported, `transform` buggy): Apple forums 700769 / 721258 / 763505; MDN browser-compat-data.
- `document_start` manifest CSS pre-paint guarantee: developer.chrome.com content_scripts manifest; Apple "Using injected style sheets and scripts".
- Safari packaging (`safari-web-extension-packager`, native iOS+macOS, referenced resources): developer.apple.com "Converting a web extension for Safari".
- Entitlement bridge (app_user_id = UUID, static webhook auth, .p8 not shared secret, idempotency, aliases/TRANSFER): RevenueCat Identifying Customers + Webhooks + In-App Purchase Key docs.
- Supabase RLS (explicit enable, public-read policy, `(select auth.uid())`, index user_id, CVE-2025-48757), custom SMTP rate limits, account-deletion 5.1.1: supabase.com docs; developer.apple.com review guidelines.
- Build tooling (WXT dual-target, Safari `--mv3` default caveat): wxt.dev target-different-browsers; 2025 State of Browser Extension Frameworks.
- Headless extension testing (Playwright `channel: 'chromium'`, persistent context, SW-derived id): playwright.dev/docs/chrome-extensions.
