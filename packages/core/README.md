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
adding a shared interface. Paid infrastructure remains dormant under the current strategy.
