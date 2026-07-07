# Still Architecture

Still is organized around a small number of deep modules with narrow interfaces. The goal is locality: a change to blocking rules, purchase state, or platform storage should be verified in one place instead of spread through every extension and app shell.

## Design goals

- Share the blocking engine across Chromium, Firefox, Safari, iOS, and macOS.
- Keep platform shells thin: each shell adapts storage, auth, purchase, and native messaging into the shared core.
- Treat remote rule updates as signed data, never executable code.
- Keep account and entitlement state server-authoritative.
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

## Entitlement flow

1. StoreKit 2 or RevenueCat Web Billing completes a purchase.
2. RevenueCat sends the event to `revenuecat-webhook`.
3. Supabase stores the server-authoritative entitlement through narrow database functions.
4. Clients call `reconcile-entitlement` to read the authoritative state.
5. Extensions and the Apple app cache the entitlement with explicit offline rules.

The user-facing tier is Still Pro. The immutable internal entitlement id remains `still_sync`.

## Settings flow

Settings are user choices, not authority. Local adapters read and write `StillSettings`; signed-in users sync settings through Supabase with last-write-wins timestamps. Entitlement never comes from client-writable settings.

## Verification surfaces

- TypeScript packages: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Supabase functions: Deno lint, check, and tests under `supabase/functions`.
- Extension behavior: Playwright fixture tests against recorded YouTube, Instagram, Facebook, and TikTok pages.
- Apple logic: StillKit unit tests plus Xcode build/sign/device validation in the release runbook.
- Mobile blocking: human-gated device validation documented in `docs/release/06-mobile-blocking-validation.md`.
