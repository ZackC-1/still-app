---
status: source-of-record (product spec)
authority_note: |
  This is the founder's original v1 product spec. Several v1 decisions here were
  REVISED during second-pass review. Where this document and
  docs/brainstorms/2026-06-23-still-second-pass-requirements.md disagree, the
  second-pass doc (and the implementation plan in docs/plans/) WIN. Known
  supersessions: per-surface toggles → per-service master toggles only;
  two-profile desktop/mobile sync → single synced settings set (no scope enum);
  "videos hidden today" counter → cut from v1; Shorts redirect mechanism →
  declarativeNetRequest network-layer redirect on Chromium, content-script
  location.replace fallback on Safari (per D7 / plan KTD1). Read the second-pass doc and
  the plan before implementing anything in Sections 4, 5, and 6 below.
---

# Still — Product & Engineering Specification (v1)

Document owner: founder
Version: v1 draft for build
Status: ready for Claude Code intake and second-pass questioning

---

## 1. Product overview

Name: Still
Tagline: The short-form video disappears. Everything else stays.

What Still is: a tool that surgically removes short-form video (YouTube Shorts, Instagram Reels, Facebook Reels, and all of TikTok) from the web, so the rest of each site looks and works exactly as normal. The short-form surfaces should feel as if they never existed, including their navigation entry points, not merely hidden behind a warning.

What Still is not: it is not a website blocker, not a willpower or accountability tool, not an ad blocker, and not a parental-control product. It does not block whole sites (except TikTok, which is almost entirely short-form video). It does not add timers, streaks, or lock modes in v1.

Core philosophy: remove the feature, not just the content. If a user would normally reach short-form video through a sidebar item, a tab, a feed pane, or a search row, that entry point is removed too. The goal is a clean, quiet version of each site with no trace of the short-form surface.

---

## 2. Scope (v1)

In scope for v1:
- Chromium extension (covers Chrome, Edge, Brave, Arc) for desktop.
- One Apple application (built from a single Swift codebase) that ships for iPhone, iPad, and Mac, and carries the Safari Web Extension. This covers Safari on iOS, iPadOS, and macOS.
- Surgical short-form removal on the four launch services (Section 4).
- A free tier (all blocking) and a single one-time paid unlock for cross-device settings sync.

Out of scope for v1 (planned later, do not build now):
- Firefox add-on (v2).
- Android (v2).
- Whole-app blocking of the native TikTok, Instagram, YouTube, and Facebook apps via Screen Time / Family Controls / a local VPN. This is a separate future module.
- Timers, schedules, sessions, focus modes, and any "hard lock" difficulty that prevents disabling. Architecture should not preclude adding these later.
- Stripe / web checkout for the paid unlock (v2). v1 sells the unlock through Apple in-app purchase only.

Minimum platform versions:
- iOS / iPadOS 17+
- macOS 14+
- Current stable Chrome and Chromium-based browsers

Languages: English only in v1. Build the UI and all user-facing strings through a localization layer (string catalog) so other languages can be added later without refactoring.

---

## 3. Brand and design system

The design must read as calm, sophisticated, and restrained. North star for information architecture and polish is Opal, but with Still's blue-and-white palette and a more utility-first, less gamified feel.

### 3.1 Identity

- Name in all plain-text contexts (App Store name, metadata, legal, anywhere the literal name is needed): "Still".
- Wordmark: the lowercase stylized mark provided by the founder (the "i" rendered as a single low dot, two clean "l" strokes, in Still Blue on white). Because the stylized wordmark can read as "st.ll" at a glance, never use the stylized form where the plain name must be unambiguous. Use the plain word "Still" there.
- App icon: provided by the founder. A single thin white horizontal line ("the horizon") with one white dot resting on it, on a Still Blue field, in a rounded-square frame. This dot-on-a-line motif is the brand's through-line and may be reused as a small in-app glyph.

### 3.2 Voice and tone

Calm and straightforward. Speak to outcomes, never to the mechanism. The product does not brag about what it removes. Copy points at the result: no distractions, no endless scrolling, mental freedom.

- Good: "Reels are gone." / "Nothing here. That's the point."
- Avoid: "Tap to enable Reels blocking." / "Block 5 surfaces now!"

A settings row describes a steady state of the world, not an action the user must take.

### 3.3 Color tokens

Pin the canonical Still Blue value from the founder's source asset before finalizing. The values below are the working set (Still Blue sampled at approximately #2A47E8 from the provided image).

Light mode:
- `--still-blue` (primary): #2A47E8
- `--still-blue-pressed` (hover/active): #1E37C2
- `--ink` (primary text): #0B1430
- `--ink-secondary` (secondary text): #4A5170
- `--surface` (page bg): #FFFFFF
- `--surface-raised` (cards, rows): #F6F7FB
- `--border`: #E3E6F0
- `--on-blue` (text/icons on Still Blue): #FFFFFF

Dark mode:
- `--still-blue`: #5A74FF (lifted for contrast on dark)
- `--still-blue-pressed`: #4259E6
- `--ink`: #EEF1FA
- `--ink-secondary`: #A7AEC8
- `--surface`: #0B0F1A
- `--surface-raised`: #141A2B
- `--border`: #232A40
- `--on-blue`: #0B0F1A

All UI must support full light and dark mode and follow the system setting.

### 3.4 Typography

- UI typeface: Inter (variable). If the founder later licenses a brand font, swap via a single token.
- Type scale (px / weight): caption 12/400, body 16/400, body-strong 16/500, label 14/500, h3 20/600, h2 28/600, h1 40/600.
- Sentence case everywhere. Never Title Case, never all caps.

### 3.5 Spacing, radius, elevation

- Spacing scale: 4, 8, 12, 16, 24, 32, 48.
- Radius: controls 8, cards 12, sheets/modals 16.
- Elevation: flat. No drop shadows beyond a single subtle 1px border on raised surfaces. No gradients except the brand's solid blue fields.

### 3.6 Component inventory (specify behavior, build to match)

- Toggle (switch): the primary control. Off = neutral track, On = Still Blue. Used for every per-service setting.
- Settings row: label on the left (outcome-phrased), toggle on the right, optional one-line secondary text below the label.
- Service card: a grouped block per service (YouTube, Instagram, TikTok, Facebook) containing a service master toggle. (Per second-pass: per-service master toggle only; no per-surface user toggles.)
- Primary button: solid Still Blue, white text, radius 8.
- Secondary button: bordered, ink text.
- Paywall sheet: a single calm screen presenting the $1.99 one-time Still Sync unlock.
- Onboarding card: full-screen, one idea per screen, generous whitespace.
- The Still placeholder: the screen shown when short-form is opened directly or when TikTok is visited. A Still Blue field, the dot-on-a-line glyph, and one calm line of copy. No buttons, no scolding.

### 3.7 Screens to build (zero-gap wireflow)

Apple app (iPhone, iPad, Mac):
1. Onboarding — Screen 1: welcome + tagline. Screen 2: the outcome. Screen 3: enable the Safari extension (guided, illustrated walkthrough; detect and reflect enabled state). Screen 4: done, lands on Settings.
2. Settings (home): a global on/off at the top, then one service card per service, then an entry to Sync.
3. Sync / account: explains cross-device sync, shows the $1.99 unlock if not purchased, and the sign-in / account state if purchased. Sign in with Apple and email magic link.
4. Per-site pause: a simple control to pause Still on the current site.

Extension toolbar popup (desktop): global on/off; pause on this site; a link that opens the full options page; current state at a glance (on / paused here / off).

Extension options page (desktop): the same settings UI as the app's Settings screen (built once as a shared web UI, see Section 8).

Note on shared UI: the Settings and Sync screens are a single web UI reused as (a) the extension options page, (b) the extension popup's expanded view, and (c) the app's settings, hosted in a WKWebView inside the Apple app. Build this UI once.

---

## 4. Blocking behavior (the core, zero ambiguity required)

Terminology note: YouTube's short-form format is officially "Shorts." Instagram and Facebook call theirs "Reels." TikTok is entirely short-form. Use the correct platform term in code and rules.

General rules that apply to every service:
- Remove the feature, including its navigation entry points, so it appears never to have existed. Do not show a label, a stub, or empty space where a removed nav item used to be; collapse the layout cleanly.
- Apply on both the desktop web layout and the mobile web layout (mobile web matters because iOS Safari is the mobile surface).
- The content script must handle single-page-app navigation: re-apply rules on route changes (history pushState/replaceState and popstate) and use a MutationObserver to catch lazily loaded and infinitely scrolled content.
- Prefer hiding stable chrome via injected CSS (display:none) and removing dynamically injected feed items via DOM removal. Never leave a flash of visible short-form before removal; inject blocking CSS as early as possible (document_start).

### 4.1 YouTube (short-form = Shorts)

Remove so it appears never to have existed:
- The "Shorts" item in the left guide/sidebar and in the collapsed mini-guide.
- The Shorts shelf/carousel on the Home feed.
- Shorts results and the Shorts shelf in Search.
- The Shorts row in the Subscriptions feed.
- The "Shorts" tab on channel pages.
- Shorts entries surfaced in related/up-next and in chips/pivot bars.

Direct navigation to a Shorts URL (`youtube.com/shorts/<id>`): redirect to the standard watch page for the same video (`youtube.com/watch?v=<id>`) when an id is present. If no id is present, show the Still placeholder. (Per second-pass + research + plan KTD1: on Chromium use a `declarativeNetRequestWithHostAccess` network-layer redirect — zero paint; on Safari, which does not reliably support `regexSubstitution` redirects, use the earliest-possible `document_start` content-script `location.replace` with a measured flash budget, plus a History-API/Navigation-API hook for in-app SPA navigations.)

### 4.2 Instagram (short-form = Reels)

Remove Reels and the ability to access Reels:
- The Reels tab in the bottom nav (mobile web) and the Reels item in the left sidebar (desktop web).
- Reels embedded inline in the Home feed.
- The Reels section and reel tiles in Explore and in Search.
- Suggested Reels.
- The Reels tab on profile grids.

Direct navigation to a Reels URL (`instagram.com/reels/...` or `/reel/<id>`): show the Still placeholder.

### 4.3 TikTok

Remove all of TikTok on the web. Replace every page on `tiktok.com` (and locale subdomains) with the Still placeholder, because the site is almost entirely short-form video. Collateral loss of TikTok web messaging and profile browsing is acceptable and intended.

Important: the native TikTok app on iOS is not affected in v1 (see Section 13). Only the web experience is blocked.

### 4.4 Facebook (short-form = Reels)

Remove all references to Reels:
- Reels in the Home feed.
- The Reels shortcut/section in the left menu.
- Reels inside Watch.
- Reels in Search and in Groups.
- Suggested and related Reels.

Direct navigation to a Reels URL (`facebook.com/reel/<id>`): show the Still placeholder.

### 4.5 Rule set format

Blocking is data-driven, not hard-coded. Define a versioned JSON rule set. Surfaces are internal authoring/QA units grouped under each service (per second-pass: the user-facing control is one master toggle per service, not per-surface).

Actions supported: `hide` (inject CSS display:none), `remove` (delete the node), `redirect` (content-script navigation rewrite), `placeholder` (replace the page/body with the Still placeholder), `blockSite` (placeholder for the entire domain, used for TikTok).

Safety model (per second-pass): a rules update that adds a new surface under an already-enabled service applies immediately; a rules update that adds a brand-new service defaults that service off until the user enables it.

### 4.6 Rule hosting and updates

- The backend hosts the canonical rule set (Section 9), and every extension fetches it at runtime so a single edit reaches all browsers the same day, without app-store resubmission.
- Each extension also bundles a default rule set so it works on first run and offline. On launch it fetches the latest from the backend, caches it locally, and falls back to the cached or bundled set if offline.
- Versioning: clients store the last good version and only swap when a newer, well-formed set is fetched.

---

## 5. Settings model and sync

(Per second-pass: SINGLE synced settings set per account — no desktop/mobile profile split, no scope-targeting UI. The original two-profile model below is superseded.)

- One settings set per account: a global on/off, four per-service master toggles, and a list of per-site pauses.
- The content script always reads a local on-device copy of the settings, so blocking applies instantly on page load with no network wait.
- When sync is off (free users): the local copy is the only copy; nothing leaves the device; each install is independent.
- When sync is on (paid users): the cloud settings are source of truth; the local copy mirrors it.
- Conflict resolution: last-write-wins, timestamped. Per-field merge is out of scope for v1.

---

## 6. Monetization, purchase, and entitlement

### 6.1 Tiers

- Free: all blocking, on all services, on all v1 platforms. No account required.
- Paid: a single non-consumable in-app purchase, "Still Sync," priced at 1.99 USD (map to the nearest Apple price point; the founder is enrolled or will enroll in the Apple Small Business Program for the 15% rate). Still Sync unlocks cross-device settings sync.

### 6.2 Purchase path (v1)

- Apple in-app purchase only, via StoreKit 2, on the iOS and Mac apps. There is no web/Stripe checkout in v1.
- Use RevenueCat to validate the purchase and manage the entitlement, and to write the entitlement to the user's Still account in the backend. (Per research: use an In-App Purchase Key (.p8) — NOT the deprecated app-specific shared secret. Set RevenueCat `app_user_id` = the Supabase auth user UUID.)
- The shipped purchase UI requires account sign-in before purchase. A dropped webhook or restore is reconciled by a server-side backend call to RevenueCat; the client may request reconcile, but client-supplied purchase state is never trusted to grant the Supabase entitlement.

### 6.3 Entitlement bridge

- The paid unlock must be tied to the Still account, not only the Apple ID, so a user who buys on their iPhone can enable sync in their desktop Chromium extension by signing into the same account.
- Flow: user creates/signs in to a Still account when turning on sync, buys Still Sync via Apple IAP on an Apple device, the entitlement is recorded against that account in the backend (via a RevenueCat webhook → Supabase Edge Function), and any device signed into that account reads the entitlement and enables sync.

---

## 7. Accounts and authentication

- Free tier: fully local and anonymous. No account, no login, nothing leaves the device.
- An account is created only when a user turns on paid sync.
- Auth methods in v1: email magic link (the universal cross-platform path) and Sign in with Apple (Apple devices only). Google later.
- Account is required to purchase and use Still Sync.
- In-app account deletion and data export are required in v1 (App Store Guideline 5.1.1).

---

## 8. Architecture and tech stack

### 8.1 Shared core (one codebase, TypeScript)
- The rule engine and content script that fetch the rules and apply them to pages.
- The settings + paywall web UI, built once, reused as the extension options page, the extension popup's expanded view, and (hosted in a WKWebView) the Apple app's settings, behind a per-host storage adapter.

### 8.2 Thin wrappers (mostly manifest and packaging)
- Chromium extension package (Manifest V3 WebExtension).
- Safari Web Extension package (the same WebExtension, packaged for Safari, delivered inside the Apple app).
- Firefox add-on package: scaffold the folder but do not build/ship in v1.

### 8.3 Apple shell (one Swift codebase)
- A single SwiftUI Xcode project producing both the iOS/iPadOS app and the Mac app (per research: separate native iOS + macOS targets sharing SwiftUI and a referenced web-extension Resources folder — not Mac Catalyst).
- Native responsibilities only: host the Safari Web Extension, run the guided "enable the extension" onboarding, host the shared settings/paywall web UI in a WKWebView, and run the StoreKit 2 / RevenueCat purchase flow.

### 8.4 Backend (one codebase)
- Supabase: Postgres, Auth, Realtime, Edge Functions.
- RevenueCat for entitlement, with a webhook into a Supabase Edge Function that updates the entitlement record.
- Hosts the canonical rule set, served to all extensions.

### 8.5 Frameworks
- Content script: vanilla TypeScript injected at document_start.
- Popup and options/settings UI: Svelte.
- Build/packaging: WXT (Vite-based; emits Chromium MV3 + Safari resources; pass `--mv3` for Safari).

---

## 9. Data model (Supabase)

- `profiles` — `id` uuid pk fk -> auth.users, `settings` jsonb (global on/off, per-service master toggles, per-site pauses), `updated_at` timestamptz. (Per second-pass: no `scope` enum — one row per user.)
- `entitlements` — `user_id` uuid pk fk -> auth.users, `still_sync` boolean default false, `source` text, `revenuecat_subscriber_id` text, `updated_at` timestamptz. User-readable, writable only through a narrow backend RPC/function after server-side RevenueCat verification.
- `revenuecat_events` — `event_id` text pk, `app_user_id` text, `processed_at` timestamptz, `payload` jsonb. Backend-only idempotency/audit table; never user-readable.
- `rule_sets` — `version` text pk, `payload` jsonb, `signature` text, `is_current` boolean, `published_at` timestamptz. Raw table is backend-writable/private; clients read only the current published rule set through a view/RPC. Published rule sets are signed with an asymmetric signature whose public key is baked into clients.
- `devices` (optional, future analytics/diagnostics).

Row Level Security: `profiles`, `entitlements`, `devices` — a user can read only rows where `user_id = auth.uid()`; entitlements are written only by backend code that has verified current RevenueCat state. `rule_sets` — public read of the current signed set only; draft/history rows and writes are restricted to backend/deploy credentials.

---

## 10. Repository structure (monorepo)

See the implementation plan in `docs/plans/` for the authoritative, research-updated structure (pnpm workspaces; `packages/core`, `packages/ext-chromium`, `packages/ext-safari`, `packages/shared-types`; `apps/apple` Xcode project; `supabase/` migrations + functions; `docs/`).

---

## 11. Privacy, permissions, analytics

- The extension requires host permission on the four supported social domains to run its content script. Request the narrowest set: `*://*.youtube.com/*`, `*://*.instagram.com/*`, `*://*.facebook.com/*`, `*://*.tiktok.com/*`. No `<all_urls>`. Declare zero data collection.
- Data leaving the device: nothing for free users. For paid sync users, only their own settings and the minimum account/entitlement data. Never collect or transmit what the user browses, watches, or blocks.
- Analytics: privacy-respecting crash reporting only (e.g., Sentry), no behavioral analytics in v1.
- No "videos hidden today" counter in v1 (cut per second-pass).
- Privacy policy and terms: ship as placeholders that the founder replaces before any store submission.

---

## 12. Division of labor

Claude Code does (all code and config): the shared core, rule engine, content script, shared settings/paywall web UI; the Chromium and Safari Web Extension packaging; the Apple Swift project up to a buildable project + a local StoreKit test config; the Supabase schema, RLS, Edge Functions, and seed rule set; the initial rule selectors for all four services.

Human does (requires a Mac, Apple account, and dashboards): Xcode builds, code signing, provisioning; Apple Developer Program enrollment and entitlement requests; App Store Connect setup, the IAP product ("Still Sync", 1.99 USD non-consumable), the In-App Purchase Key (.p8), sandbox testers, screenshots, submission; Chrome Web Store developer account and submission; RevenueCat dashboard setup; Supabase project creation and production keys; custom SMTP (Resend) domain verification; final privacy policy and terms copy; domain and any marketing site.

Claude Code must not claim to perform the human tasks. Where a human step is a prerequisite, generate the code/config and clear instructions, then stop and hand off.

---

## 13. Known limitations

- Web only, and Safari only on mobile. v1 does not touch Chrome/Firefox on iOS or the native apps. An inherent platform constraint, not a defect.
- Apple-only purchase in v1. A user with no Apple device can use all free blocking on Chromium but cannot buy Still Sync until v2 adds web checkout.
- Maintenance is an ongoing task. The four services change their markup regularly. The backend-hosted, runtime-fetched rule set exists so a fix is a single server edit. Treat keeping selectors current as a core, recurring operational task.
- Soft enforcement. A user can disable the extension or revoke its permissions. Still is not a lock.

---

## 14. Acceptance criteria (v1 done)

- A user can install the Chromium extension and the Apple app, and on both, YouTube Shorts, Instagram Reels, Facebook Reels, and all of TikTok are reliably removed on the web, including their navigation entry points, with no visible flash on static chrome and no broken layouts.
- Direct Shorts links redirect to the standard watch page; direct Reels links and TikTok show the Still placeholder.
- Per-service toggles work and persist locally.
- A user can buy Still Sync (1.99 USD) via Apple IAP, create/sign in to an account, and have their single settings set sync across devices signed into that account, including the desktop Chromium extension.
- Free users never have anything leave their device.
- Full light and dark mode, matching the Still design tokens.
- The rule set can be updated from the backend and clients pick up the change without an app-store resubmission.
- In-app account deletion and data export work.

---

## 15. Resolved second-pass decisions

See `docs/brainstorms/2026-06-23-still-second-pass-requirements.md` for the full resolved decision log, drafted copy, scope boundaries, and outstanding human/asset items.

---

## 16. Build sequencing

See the implementation plan in `docs/plans/` for the authoritative, autonomy-optimized sequencing.
