# Still — domain glossary

Names the load-bearing concepts in this codebase. Use these terms in code, comments, and reviews.

- **Rule set** — the signed, versioned DATA describing what to block: services → surfaces →
  selectors/actions. Never code. The bundled **seed** (`packages/core/rules/seed.json`) is the
  trusted offline floor; fetched sets are Ed25519-verified against build-scoped trusted keys.
- **Surface** — one authored blocking unit under a service (e.g. `yt-home-shelf`), with an action
  (`hide`/`remove`/`redirect`/`placeholder`/`blockSite`) and a monetization `tier`.
- **Tier** — the ONE monetization axis (`free` | `pro`), authored per surface in the seed. The
  engine gates by it, the CSS generator buckets by it, and service-row locking derives from it
  (`core/rules/tiers.ts`). `requiredCapability` is reserved authored data, deliberately unread.
- **Rule-set loader** (`core/rules/loader.ts`) — the one extension wiring for the signed rule-set
  pipeline: background fetch → verify → cache; content applies the newest of {cached, bundled}.
  Shared by Safari, Chromium, and Firefox builds.
- **Engine** (`core/rules/engine.ts`) — pure decisions + DOM application. `applyDom` is the full
  hide+remove walk; **`applyRemovals`** is the per-mutation-frame fast path used when the packaged
  manifest CSS owns every hide surface (applied rule set = bundled seed).
- **Settings** (`StillSettings`) — the user's toggles, synced last-write-wins by `updatedAt`.
  Client-writable; never carries entitlement.
- **Entitlement** — the server-authoritative "is this account Pro" bit (RevenueCat →
  `revenuecat-webhook` → Supabase `entitlements.still_sync` → reconcile). Reaches the Safari
  extension via the App-Group **entitlement lane** (StillKit `EntitlementBridge`), stamped with the
  last server-confirmed time so the 30-day offline TTL is real. User-facing name: **Still Pro**;
  immutable internal id: `still_sync`.
- **Apple session orchestrator** (`core/sync/apple-session.ts`) — the tested auth/purchase/
  entitlement spine of the WKWebView app: sign-in exchange, double-charge + offline guards,
  pending-vs-authority purchase states, restore, Ask-to-Buy recheck, teardown parity. The
  app-webview entrypoint is thin wiring around it.
- **Extension UI factory** (`core/ui/extension-setup.ts`) — the one popup/options controller
  wiring every extension build shares. Purchase/auth capabilities are an OPTIONAL injection
  passed only by ext-chromium entrypoints — the uninjected default (Safari) stays purchase-free
  by construction (guideline 3.1.1).
- **Extension session orchestrator** (`core/sync/extension-session.ts`) — the apple-session
  mirror for Chrome/Firefox: background-owned Supabase session, OTP sign-in, reconcile→
  entitlement-record writes, web-checkout hand-off with a persisted checkout-pending lifecycle,
  nudge gating (24h staleness / 6h throttle), `resume()` from cached entitlement on worker wake,
  and one shared voluntary-teardown helper. The ext-chromium background entrypoint is thin
  wiring around it; entitlement reaches Chrome/Firefox through this lane the way the App-Group
  entitlement lane serves Safari.
- **App-Group bridge** — the Swift↔web↔extension seam on Apple: settings lane (`SettingsBridge`,
  LWW) + entitlement lane (`EntitlementBridge`, app-written only after server reconcile).
- **Auth gate** (`supabase/functions/_shared/auth.ts`) — the one authenticated-request preamble
  every browser/app-called function wraps its body in (`withAuthenticatedUser`): OPTIONS preflight →
  POST-only → Bearer shape → `verifyJwt` (HS256/ES256 + defense-in-depth claims) → UUID subject.
  The subject UUID never comes from the request body (KTD5 IDOR defense); handler bodies receive
  only what the gate proved. `AuthDeps` is the shared auth slice per-function Deps extend.
- **Design contract** — the visual invariants every distributed UI host (extension popups/options,
  WKWebView app, native onboarding, docs pages) must share: self-hosted InterVariable, Still Blue,
  system dark mode, no CSS `zoom`. Enforced as file-content assertions in
  `core/ui/__tests__/design-contract.test.ts`, not manual parity review. Note "host" here — a
  rendered UI destination — is distinct from the rule-set **Surface** above (a blocking unit).
- **Install generation** — the per-install id the app stamps into the App Group on launch
  (StillKit `InstallGeneration`, idempotent) and returns inside every entitlement-lane reply. The
  Safari extension purges its cached entitlement only when the id it last saw CHANGES (reinstall
  detected — Safari's extension storage survives app deletion, issue #63); an absent/unreadable id
  is never a purge signal (offline never-downgrade), and a null `entitled` in the reply envelope is
  never read as entitled (it gates a paid feature). The marker key must never be bumped as a soft
  reset — every device would look reinstalled and mass-relock Pro; migrate the value forward instead.
