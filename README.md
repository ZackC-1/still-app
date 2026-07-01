# Still

Surgically removes short-form video — YouTube Shorts, Instagram/Facebook Reels, and all of TikTok — across Chromium and Safari, with a native Apple app for the Safari extension and the one-time "Still Pro" purchase.

Still is **not** a willpower app: no timers, streaks, locks, or shaming. It removes the short-form surfaces and their entry points and gets out of the way. Regular feeds are left untouched.

## What it is

| Piece | What it does |
|---|---|
| **WebExtension** | A data-driven content script that hides/removes short-form surfaces and redirects Shorts URLs to the standard watch page. Ships as a Chromium MV3 extension and a Safari Web Extension from one codebase. |
| **Apple app** | Hosts the Safari Web Extension (iOS + macOS) and runs the StoreKit 2 / RevenueCat purchase for "Still Pro". |
| **Supabase backend** | Rule-set hosting (selectors update without an app-store resubmission), magic-link auth, per-account settings sync, and the entitlement bridge. |

## Architecture

One shared TypeScript core feeds three thin shells (Chromium extension, Safari extension, Apple WKWebView) and a Supabase backend. Blocking is driven by a **versioned, Ed25519-signed JSON rule set** — the packaged extension is the complete interpreter; remote rule sets supply only validated data (selectors, match patterns, action enum values), never executable code.

See [`docs/plans/2026-06-23-001-feat-still-build-plan.md`](docs/plans/2026-06-23-001-feat-still-build-plan.md) for the full design and [`docs/Still-Spec-v1.md`](docs/Still-Spec-v1.md) for the product spec.

## Repository layout

```
packages/
  shared-types/    rule set, settings, entitlement types
  core/            rule engine, content script, Svelte UI, storage adapter, seed rule set
  ext-chromium/    WXT MV3 extension (Chrome/Edge/Brave/Arc)
  ext-safari/      WXT --mv3 build → resources for Xcode
  ext-firefox/     scaffold only (deferred)
apps/
  apple/           Xcode project: iOS + macOS targets (Phase B)
supabase/
  migrations/      schema + RLS
  functions/       revenuecat-webhook, reconcile-entitlement, delete-user, export-user-data, selector-canary
tests/
  fixtures/        recorded HTML per service for Playwright
```

## Development

Requires Node 22+, pnpm, the Supabase CLI + Docker (local Postgres/functions), and Playwright (Chromium channel).

```bash
pnpm install
pnpm -r build          # builds both extension dist/ folders
pnpm -r test           # rule-engine + core unit tests
pnpm exec playwright test --project=fixtures   # extension on recorded fixtures
```

Load the built Chromium extension from `packages/ext-chromium/.output/chrome-mv3` (build the `dist/`, never load source).

## Build phases & autonomy

The build is split by what an autonomous agent can complete without Apple credentials:

- **Phase A** (autonomous, CI-green): monorepo, core, Chromium extension, the entire Supabase backend including the RevenueCat webhook bridge (proven with a *faked* payload), and the full test harness.
- **Phase B** (human-gated): the agent writes 100% of the Swift / StoreKit / RevenueCat code, but a human on a Mac runs Xcode signing, App Store Connect IAP setup, RevenueCat config, and the real sandbox purchase.

External-service connections and who owns each gate live in [`docs/CONNECTIONS.md`](docs/CONNECTIONS.md).

## Privacy

Host permissions are limited to the four service domains (`youtube.com`, `instagram.com`, `facebook.com`, `tiktok.com`) — never `<all_urls>`. Both stores' privacy disclosures declare zero data collection. Free (sync-off) users transmit nothing; their settings live only on-device.
