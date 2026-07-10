# Still

[![CI](https://github.com/ZackC-1/still-app/actions/workflows/ci.yml/badge.svg)](https://github.com/ZackC-1/still-app/actions/workflows/ci.yml)

Still removes short-form video surfaces from YouTube, Instagram, Facebook, and TikTok. It is designed to be quiet infrastructure: no timers, streaks, locks, shame loops, or attention dashboards. The app removes the short-form entry points and leaves regular feeds alone.

This repository is public so people who install Still can inspect what runs in the browser, how privacy is handled, how paid unlocks are verified, and how releases are tested.

> **Project status:** Still is in pre-release validation. The current clients and cross-surface sync
> have passed the release test matrix, but store review and public distribution are intentionally
> pending. See [release validation](docs/release/VALIDATION.md) for the verified commit and scope.

## What Still ships

| Surface | What it does |
|---|---|
| Browser extensions | Shared WebExtension code for Chromium and Firefox builds, with a data-driven content script for blocking short-form surfaces. |
| Safari extension | The same blocking core packaged as a Safari Web Extension. |
| Apple app | iOS and macOS host app for the Safari extension, StoreKit 2 purchase, and the extension bridge. |
| Supabase backend | Auth, settings sync, entitlement reconciliation, signed rule-set hosting, export, deletion, and selector canary functions. |

## Product model

| Tier | Included |
|---|---|
| Free | YouTube Shorts removal. No account required. Settings stay on-device. |
| Still Pro | Reels, TikTok, Facebook short-form surfaces, and cross-device settings sync. One-time purchase. |

Still does not collect browsing history. Host permissions are limited to `youtube.com`, `instagram.com`, `facebook.com`, and `tiktok.com`; the extension never requests `<all_urls>`.

## Architecture

Still is a TypeScript-first monorepo with thin platform shells:

```
packages/
  shared-types/    rule set, settings, and entitlement types
  core/            rule engine, content script, Svelte UI, storage, sync, native bridge adapters
  ext-chromium/    WXT MV3 extension for Chromium; also produces the Firefox build
  ext-safari/      WXT Safari extension resources consumed by the Apple app
apps/
  apple/           Xcode project for iOS, macOS, Safari extension, and StillKit
supabase/
  migrations/      schema, RLS, indexes, and rule-set seed data
  functions/       Edge Functions for billing, account, entitlement, and canary flows
tests/
  fixtures/        recorded service pages used by Playwright
  playwright/      extension integration tests
  smoke/           non-gating real-site smoke checks
docs/
  release/         first-release runbooks for every store and backend dependency
```

The blocking engine consumes a signed, versioned JSON rule set. Remote updates are data only: selectors, match patterns, action enum values, and tier metadata. They are schema-checked and Ed25519-verified before use; remote rule sets never ship executable code.

For a deeper map, start with [docs/README.md](docs/README.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Trust signals

- CI runs lint, typecheck, unit tests, extension builds, Supabase function checks, and Playwright fixture tests on every PR.
- `main` is protected by a GitHub ruleset requiring PRs and the required status checks before merge.
- Real secrets are excluded from the repository. Tracked config files contain empty defaults or public client keys only.
- Store privacy copy lives in [docs/privacy.html](docs/privacy.html), and support copy lives in [docs/support.html](docs/support.html).
- Security reporting instructions live in [SECURITY.md](SECURITY.md).
- The current release validation record lives in [docs/release/VALIDATION.md](docs/release/VALIDATION.md).

## Development

Requirements:

- Node.js 22+
- pnpm 11.x
- Supabase CLI and Docker for local database/function work
- Playwright Chromium for extension fixture tests
- Xcode 16+ for Apple targets

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright test --project=fixtures
```

Load unpacked development builds from:

- Chromium: `packages/ext-chromium/dist/chrome-mv3`
- Firefox: `packages/ext-chromium/dist/firefox-mv3/manifest.json`

Build output is generated and ignored by Git. Do not load the source directory as an extension.
Cloud auth, sync, and purchase flows require local environment configuration; blocking and most
tests work without production credentials. Copy the relevant package-level `.env.example` file and
use local or development values only.

Apple helpers live in [apps/apple/scripts/README.md](apps/apple/scripts/README.md).

## Release operations

The release runbook starts at [docs/release/README.md](docs/release/README.md). It documents the Apple App Store, Chrome Web Store, Firefox AMO, RevenueCat, Supabase, and mobile-validation steps, including the human-gated credentials and portal work that cannot be automated safely.

## Contributing

Focused fixes and documentation improvements are welcome by prior maintainer agreement. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before starting work, use the issue templates for bugs and feature
requests, and keep security-sensitive reports out of public issues.

## License

See [LICENSE](LICENSE). The repository is currently source-available for transparency, not open-source licensed for reuse.
