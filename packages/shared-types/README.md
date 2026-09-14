# Shared types

Rule-set, settings and entitlement contracts consumed by the client workspaces.
[package.json](package.json) exports `src/index.ts`; there is no separate generated build output.

Keep cross-package data contracts here and implementation behavior in
[core](../core/README.md). Update consumers and validation together when a contract changes.
From the repository root, run `pnpm --filter @still/shared-types typecheck`.
