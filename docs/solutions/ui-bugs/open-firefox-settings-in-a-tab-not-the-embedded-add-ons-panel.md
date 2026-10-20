---
title: Open Firefox's Settings page in a tab; the embedded Add-ons Manager panel hides fixed-position sheets
category: ui-bugs
track: bug
problem_type: integration_error
module: packages/ext-chromium
applies_when: An extension page uses position:fixed sheets, dialogs or notices and is shown by Firefox as an embedded options page (options_ui.open_in_tab false), or a Firefox tester reports a grey Settings page with no sheet
date: 2026-10-20
status: active
tags: [firefox, options_ui, add-ons-manager, position-fixed, sheet, wxt, manifest]
---

## Symptom

ISS-0097 (Firefox desktop, Still 2.1.1.392, 19 Oct 2026): on the Settings page, after Sign out,
clicking Sign in turned the whole page grey with no sign-in sheet, so signing in was impossible.
Minutes later the same steps worked. No console error, no crash.

## Cause

With `options_ui.open_in_tab: false` (WXT's default for an options entrypoint), desktop Firefox
shows the options page inside the Add-ons Manager (about:addons → the add-on → Preferences) in a
`<browser>` panel that Firefox grows to the page's full content height. The page's own viewport is
therefore as tall as the page. Measured on 2.1.1.400 in a 1280×820 headless window: the panel was
1209 px tall inside a 735 px about:addons viewport.

The sign-in sheet is `position: fixed; inset-block-end: 0` with a `position: fixed; inset: 0`
scrim. Inside that panel the scrim covers all 1209 px and the sheet sits at the panel's bottom
(top at 1128 px in the about:addons viewport), about 400 px below the fold when the Add-ons Manager
is scrolled to the top, which is where the sync card's Sign in button is. Scrolling about:addons to
the bottom brings the sheet into view (top at 346 px), which is why the owner's retry worked: the
page was scrolled further down that time. The centred `.dialog` (Delete account, Stop sharing)
and any bottom-pinned notice land the same way.

Chrome is not affected: its embedded options dialog in chrome://extensions has a bounded, scrolling
viewport. Firefox for Android has no embedded host and opens the page as a tab either way.

## Fix

Firefox opens Settings in its own tab. `runtime.openOptionsPage` (the popup's Settings button,
first-run's Open Settings, the Still Pro hand-off in `lib/pro-navigation.ts`) honours the key and
reuses an open tab, so no caller changed.

WXT writes `options_ui` from the entrypoint *after* merging the `manifest` option, so a value in
`stillManifest` would be overwritten, and the `<meta name="manifest.open_in_tab">` form applies to
every browser. The change is a `build:manifestGenerated` hook in `wxt.config.ts` that calls the
exported `settingsPageHost(browser, manifest)`, pinned by `lib/__tests__/firefox-manifest.test.ts`
(Firefox true; Chrome, Chromium, Edge and Safari untouched).

## How to check

- `pnpm --filter @still/ext-chromium build:firefox` → `dist/firefox-mv3/manifest.json` has
  `"options_ui": {"open_in_tab": true, "page": "options.html"}`; the Chrome build keeps `false`.
- Real Firefox over BiDi (`tests/firefox/_bidi.ts` style): from an extension page call
  `browser.runtime.openOptionsPage()`; `browsingContext.getTree` lists a top-level
  `moz-extension://…/options.html` tab and no about:addons; a second call adds no tab. The embedded
  panel is reachable only through `browser.extension.getViews()` from another extension page (BiDi
  does not list the Add-ons Manager's nested browser), which is how the numbers above were taken.

## Pitfalls

- Do not "fix" each sheet by anchoring it to the top of the embedded panel: the dialogs opened from
  the Help card at the bottom of the page would then be above the fold instead, and nothing inside
  the panel can scroll the Add-ons Manager.
- `innerHeight === document.documentElement.scrollHeight` is a symptom of the embedded host, not a
  test for it; `browser.tabs.getCurrent()` resolving to `undefined` is.
