# Chromium and Firefox extension

One WXT package builds both Chromium and Firefox. Keep shared behavior in
[core](../core/README.md); use this package for browser-specific wiring.

- `entrypoints/`: background, content script, popup and options entrypoints discovered by WXT.
- `lib/`: browser session/storage adapters and their tests.
- `public/`: packaged icons, declarative redirect rules and license notices.
- `wxt.config.ts`: browser manifest and build configuration.

Run from the repository root:

| Task | Command | Generated output |
|---|---|---|
| Chromium | `pnpm --filter @still/ext-chromium build` | `dist/chrome-mv3/` in this package |
| Firefox | `pnpm --filter @still/ext-chromium build:firefox` | `dist/firefox-mv3/` in this package |
| Unit tests | `pnpm --filter @still/ext-chromium test` | Test report |

Load generated output in the browser, not `entrypoints/`. `dist/` and `.wxt/` are ignored.
[Chrome](../../docs/release/02-chrome-web-store.md) and
[Firefox](../../docs/release/03-firefox-amo.md) have separate submission procedures.
