# Safari extension resources

WXT builds the WebExtension consumed by the [Apple host](../../apps/apple/README.md).
Shared blocking and UI come from [core](../core/README.md); `lib/` adapts native settings,
entitlement and account status through the Safari bridge.

- `entrypoints/`: background, content script, popup and options surfaces.
- `public/`: packaged icons and font license.
- `wxt.config.ts`: Safari manifest and resource output configuration.
- `lib/__tests__/`: bridge, reconciliation, CSS and layout regressions.

From the repository root, run `pnpm --filter @still/ext-safari test` and
`pnpm --filter @still/ext-safari build`. Generated resources live in ignored `dist/`.
Xcode copies the built resources into the extension; this directory alone is not an installable
Safari app. Follow the [Apple build guide](../../apps/apple/scripts/README.md) for native builds.
