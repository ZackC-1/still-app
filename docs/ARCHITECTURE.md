# Still Architecture

> **Still 2.0:** All four blocking services and optional settings sync are free. Sign-in gates
> sync only. Both paid-tier flags are disabled. Purchase and entitlement descriptions below
> document retained infrastructure, not a requirement to use this release.

Still is organized around a small number of deep modules with narrow interfaces. The goal is locality: a change to blocking rules, purchase state, or platform storage should be verified in one place instead of spread through every extension and app shell.

## Design goals

- Share the blocking engine across Chromium, Firefox, Safari, iOS, and macOS.
- Keep platform shells thin: each shell adapts storage, auth, purchase, and native messaging into the shared core.
- Treat remote rule updates as signed data, never executable code.
- Keep account state server-authoritative. Entitlement has two authorities (ADR 0003): the server
  decides what the account owns; on Apple platforms the device's StoreKit receipt additionally
  grants device-local Pro, with StillKit's StampPolicy as the single never-downgrade gate on the
  App Group stamp.
- Make privacy claims enforceable in code: narrow host permissions, no browsing-history collection, no sync unless the user signs in.

## Runtime modules

| Module | Interface | Implementation |
|---|---|---|
| Rule set | Versioned JSON data: services, surfaces, selectors, actions, and tier metadata. | `packages/core/rules/seed.json`, Supabase-hosted production rule sets, Ed25519 signatures. |
| Rule-set loader | Load the newest trusted rule set from bundled seed or verified cache. | `packages/core/src/rules/loader.ts`, `fetch.ts`, `signature.ts`, and trusted keys. |
| Engine | Decide which surfaces apply and mutate the DOM. | `packages/core/src/rules/engine.ts`, content observers, redirect handling, generated CSS. |
| Extension UI factory | One popup/options controller for every extension build. | `packages/core/src/ui/extension-setup.ts` plus Svelte components in `packages/core/src/ui/`. |
| Extension session orchestrator | Browser-extension auth, checkout, entitlement reconcile, and settings sync. | `packages/core/src/sync/extension-session.ts`, injected by Chromium/Firefox background code. |
| Apple session orchestrator | WKWebView sign-in, purchase, entitlement, restore, and teardown flow. | `packages/core/src/sync/apple-session.ts`, wired by `packages/app-webview`. |
| App-Group bridge | Settings and entitlement lanes between the Apple app and Safari extension. | StillKit modules under `apps/apple/StillKit/Sources/StillKit/`. |
| Supabase Edge Functions | Server-side account, checkout, entitlement, webhook, export, deletion, and canary interfaces. | `supabase/functions/*`, shared stores in `supabase/functions/_shared/`. |

## Rule-set flow

1. A trusted rule set is authored as JSON and signed with the production Ed25519 key.
2. Extensions ship with a bundled seed rule set so blocking works offline.
3. The loader fetches the latest rule-set data when configured with Supabase.
4. Schema validation and signature verification run before the data can enter the cache.
5. The engine applies the newest trusted rule set available: cached production data or bundled seed.

Remote data can change selectors and actions inside the existing interpreter. It cannot add arbitrary JavaScript.

## Retained entitlement flow

1. StoreKit 2 or RevenueCat Web Billing completes a purchase.
2. RevenueCat sends the event to `revenuecat-webhook`.
3. Supabase stores the server-authoritative entitlement through narrow database functions.
4. Clients call `reconcile-entitlement` to read the authoritative state.
5. Extensions and the Apple app cache the entitlement with explicit offline rules.

The dormant paid tier is Still Pro. The immutable internal entitlement id remains `still_sync`.

## Settings and account flow

Settings are user choices, not entitlement authority. Local adapters read/write `StillSettings`
without a network dependency for blocking. One global switch and four service switches are active;
the legacy pause field is normalized/ignored. Optional sign-in uses the shared email-code flow.

`SyncService` starts free settings sync independently of entitlement reconciliation. Server profile
writes carry a version, server timestamp and write ID. First-time reconciliation can seed local
settings, adopt a newer account, or start a new account from defaults when the device contains
another person's state. Subsequent reconciliation compares the complete anchored server-row state;
it is not unbounded device-clock LWW. See [the decision table](PRODUCT.md#settings-sync-and-account-safety).

Realtime updates and local storage notifications propagate accepted settings. The Apple
`SettingsBridge` broadcasts App Group changes to the app and extension; sync epochs permit account
adoption without retaining the previous account's version. Failed uploads retry with bounded
backoff, and delayed acknowledgements cannot replace newer local changes. Lifecycle guards discard
work from old sessions, even when the same UUID signs back in.

Sign-out stops this installation's sync and clears its local session without revoking other devices
as the intended action. Blocking/settings persist. The last-synced-account marker survives sign-out
and deletion to protect the next account on a shared device. Export/delete endpoints authenticate
the current user; export read failures fail closed rather than returning a misleading partial export.

## Privacy and deployment boundaries

Migration 0012 removed paid-sync gating; 0013 adds short-lived derived security counters and cleanup.
Account deletion removes active account/settings/account-entitlement records and linked counters.
Separate historical billing events, RevenueCat records, support mail and provider logs/backups follow
[the published current-practice policy](https://stillapp.fit/privacy/). The retained Apple SDK can
communicate while signed out; no browsing-history collection is introduced.

[Connections](CONNECTIONS.md) documents actual configuration, and [the release record](release/2026-09-14-release-status.md)
attributes backend, website and store state. Current main, a submitted package and the live website
can have different source commits: `gh-pages` publishes separately and later tooling/docs changes
do not rebuild pending store artifacts.

## Verification surfaces

- TypeScript packages: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Supabase functions: Deno lint, check, and tests under `supabase/functions`.
- Extension behavior: Playwright fixture tests against recorded YouTube, Instagram, Facebook, and TikTok pages.
- Apple logic: StillKit unit tests plus Xcode build/sign/device validation in the release runbook.
- Mobile blocking: human-gated device validation documented in `docs/release/06-mobile-blocking-validation.md`.
