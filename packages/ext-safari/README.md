# Safari extension resources

WXT builds the WebExtension consumed by the [Apple host](../../apps/apple/README.md).
Shared blocking and UI come from [core](../core/README.md); `lib/` adapts native settings,
entitlement and account status through the Safari bridge.

- `entrypoints/`: background, content script, popup and options surfaces.
- `public/`: packaged icons and font license.
- `wxt.config.ts`: Safari manifest and resource output configuration.
- `lib/__tests__/`: bridge, reconciliation, CSS and layout regressions.

The V3 popup and settings page are a developer opt-in that matches the Apple app's: build with
`VITE_APPLE_ATOMIC_SETTINGS=true` and no Supabase values, for both this package and
`packages/app-webview`. Even then they appear only once the app has converted the saved record;
otherwise the existing screens show. Default builds are byte-identical without it, which
`node scripts/bundles/identity.mjs` checks (snapshot before and after, then diff).

From the repository root, run `pnpm --filter @still/ext-safari test` and
`pnpm --filter @still/ext-safari build`. Generated resources live in ignored `dist/`.
Xcode copies the built resources into the extension; this directory alone is not an installable
Safari app. Follow the [Apple build guide](../../apps/apple/scripts/README.md) for native builds.
