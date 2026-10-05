# WebKit bundle lane (T2)

The built Safari extension pages (popup and settings, from `packages/ext-safari/dist/safari-mv3`)
and the built Apple app web view (`packages/app-webview/dist/index.html`), opened in Playwright's
WebKit at 2x. The native host boundary is answered by a recorded-state shim that lives only here.
Opt-in and local: not part of CI, not in the root Playwright config.

```bash
# 1. The V3 opt-in builds (default builds fold these screens away). Unconfigured only.
VITE_APPLE_ATOMIC_SETTINGS=true pnpm --filter @still/ext-safari build
VITE_APPLE_ATOMIC_SETTINGS=true pnpm --filter @still/app-webview build
# 2. Playwright's WebKit, once: pnpm exec playwright install webkit
# 3. Lane checks (journeys on the real pages, the shim guard)
pnpm exec playwright test -c tests/qa/webkit/playwright.config.ts
# 4. T2 visual comparison against the design package (V1 gate, unchanged)
node tests/visual/real/webkit/run.mjs                 # every T2 frame
node tests/visual/real/webkit/run.mjs --only d02,d12  # some frames
node tests/visual/real/webkit/run.mjs --self-test     # proves a 2px shift fails the gate
node tests/visual/real/webkit/run.mjs --app-entry emitted-chunk   # DIAGNOSTIC only, see Findings
```

The visual runner prints `SKIPPED` and exits 0 when the private design package
(`STILL_DESIGN_PACKAGE`, default `build/v3/still-design-system-v3.2`) is absent. Reports go to
`tests/visual/real/webkit/.output/report.md` (gitignored).

Note: rebuilding the Safari extension with the flag replaces the default `dist/safari-mv3` that
`tests/playwright/_extension.ts` may use. Rebuild without the flag afterwards if you need it.

## How it works

- `harness.ts` serves each build directory from its own loopback origin, opens a WebKit context
  (deviceScaleFactor 2, fixed clock, en-US, UTC) and installs the shim in every frame.
- `shim/boundary-shim.ts` (in the page) fakes only the host boundary:
  `browser.runtime` / `browser.storage` for the extension origin, `window.webkit.messageHandlers.still`
  for the app origin. `runtime.getURL` answers with a `safari-web-extension:` URL so the shared
  adapter takes its Safari lanes. Every message goes to one exposed binding.
- `shim/native-model.ts` (in Node) answers each message with the reply shape of the Swift host that
  produces it (`SafariWebExtensionHandler`, `SettingsBridge`, `WebBridgeRouter`, the extension
  background's routers). The App Group record is held and changed by the reviewed TypeScript
  `AtomicSettingsWriter`, which StillKit is parity-tested against, so recorded states and toggle
  commits are real records. Every message is logged for the specs.
- `shim/states.ts` names the recorded states (fresh, Still off, macOS, app with onboarding, Restore
  answers, native host absent, a legacy record).
- `guard.spec.ts` proves no product source, package config or built bundle references the shim.

What the lane cannot prove: Safari, iOS or the extension runtime itself. Safari's popup sheet,
popover and window chrome are drawn by the visual runner from V1's review frame, not by Safari; no
content script runs. Playwright cannot serve the `safari-web-extension:` scheme, so a page's first
settings read uses the extension page's `still:settings-read` message lane rather than its direct
native `get` (writes do use the native `settingsIntent`); the shim answers both from the same record.

## Findings (2026-10-05)

1. **The opted-in Apple web view renders a blank screen.** `dist/index.html` inlines a module that
   still contains Vite's unreplaced preload placeholder `__VITE_PRELOAD__` (twice). When `main.ts`
   loads the D12 onboarding or the D04 settings module, the call throws a ReferenceError that
   `mountAppleScreens` swallows, so nothing mounts. The separately emitted `dist/assets/index-*.js`
   is byte-identical except that the placeholder is `void 0` (pinned by `apple-webview.spec.ts`).
   Probable cause: `packages/app-webview/vite.config.ts`'s `inlineBundle` hook copies `chunk.code`
   into the page before Vite resolves the placeholder in the emitted chunk. Default (store) builds fold these imports away and are not affected.
   `--app-entry emitted-chunk` and the `DIAGNOSTIC` specs use that emitted chunk to check the
   screens behind the bug. They are never a verdict.
2. **D12 onboarding does not fill the web view.** `.ob { min-height: 100% }` resolves against
   `#app` and `body`, whose heights are auto (`min-block-size: 100%` on `html, body, #app` does not
   make them definite), so the content and the Continue button sit at the top instead of using the
   whole screen as designed. Seen in the diagnostic captures; pinned as an expected failure.
3. **The iOS Safari popup is 380 px wide and centred on wider phones.** `.popup` clamps to
   `--popup-inline-size` (380), so on a 393-wide iPhone 15 sheet the design's edge-to-edge layout has
   6.5 px gutters each side.
4. **Paid tier off, the popup and settings rows still show a "Still Pro" lock** with the accessible
   name "… Included in Still Pro. Open the Still app" (popup) or "… See Still Pro" (settings), on a
   button with no route (owner decision 14 is unwired). No price, purchase or sign-in appears.
5. **The iPhone app cannot show the "Turn on Still in Safari" card** (D04-01): iOS never observes
   the extension's state, so the card renders only on macOS with the extension off.
