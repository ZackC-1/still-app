# Shared core

Shared blocking, settings, sync and Svelte UI for every Still client. Platform shells inject
browser storage, native messaging and authentication adapters through the public exports in
[package.json](package.json).

- `src/rules/` and `rules/seed.json`: signed rule data, validation and blocking decisions.
- `src/content/`: page observers and DOM application.
- `src/ui/`: shared controls, copy, styles and assets.
- `src/storage/`, `src/sync/`, `src/native/`, `src/entitlement/`: persistence and platform contracts.
- `scripts/`: rule signing and packaged CSS generation. Private signing keys stay ignored.
- `__tests__/` beside each subsystem: focused unit and regression tests.

From the repository root: `pnpm --filter @still/core test` or
`pnpm --filter @still/core typecheck`. This package exports source; client builds bundle it.
See the [architecture](../../docs/ARCHITECTURE.md) and [vocabulary](../../CONCEPTS.md) before
adding a shared interface. Shipped 2.x keeps paid infrastructure dormant; V3 preparation follows
the approved [strategy](../../STRATEGY.md).

Platform production code imports the explicit paths in the export map, such as
`@still/core/storage`, `@still/core/invitations`, `@still/core/rules/packaged`, and
`@still/core/ui/v3/text-scale`. Add a consumed leaf deliberately instead of exporting all source
paths with a wildcard. Tests and build tools can still inspect physical sources and rule fixtures.
ESLint enforces this boundary for Chromium, Safari and Apple webview production code.

Keep type-only imports type-only. Load optional screens through the existing dynamic imports:
`import("@still/core/ui/v3/DesktopPopup.svelte")` and
`import("@still/core/ui/v3/ExtensionSettings.svelte")` preserve the lazy loading boundary.
`@still/core/ui/v3/AppleSettings.svelte` is an app-only leaf; never re-export it from `@still/core/ui`
because its global stylesheet would reach other hosts. Apple keeps `rootDir: src`; package
resolution replaces the previous `node_modules/@still/core/src` paths without widening that root.
