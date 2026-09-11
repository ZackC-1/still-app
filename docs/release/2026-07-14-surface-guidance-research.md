# Surface-specific guidance research — July 14, 2026

## Sources and durable platform facts

- [Chrome `chrome.action` documentation](https://developer.chrome.com/docs/extensions/reference/api/action): a newly installed extension appears in the Extensions menu (the puzzle icon); users may pin its action to the toolbar. Chrome also exposes `action.getUserSettings()` for an optional future pinned-state refinement.
- [MDN `action` manifest reference](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/action): Firefox supports the Firefox-only `action.default_area` field. `navbar` makes the toolbar the default for a new install, while users can still move the action through Firefox customization.
- [Apple: Safari extensions on iPhone](https://support.apple.com/guide/iphone/get-extensions-iphab0432bf6/ios): Safari’s Page Menu leads to **Manage Extensions** on iPhone and iPad.
- [Apple: Safari extensions on Mac](https://support.apple.com/en-us/102343): users manage extensions in **Safari > Settings > Extensions** and can use an enabled extension from its toolbar button.

## Product decisions implemented in this PR

1. The shared settings UI now accepts a small host-supplied guidance card, so all settings surfaces use the same accessible component without pretending their browser controls are identical.
2. Chromium builds explain the Extensions-menu/pinning path. Firefox builds explain their toolbar placement and customization path, and set Firefox’s new-install `action.default_area` to `navbar`.
3. Safari extension popups/options and the native app settings webview explain both documented Safari paths: Page Menu → Manage Extensions on iPhone/iPad; toolbar or Safari settings on Mac.
4. Native onboarding repeats the correct return-to-Safari affordance on its completion screen, when it is most useful.

## Scope intentionally deferred

Chrome can report whether a user has pinned Still through `chrome.action.getUserSettings()`. The current guidance is deterministic and useful whether the popup is opened from the Extensions menu or the toolbar; a later experiment can personalize the copy after measuring whether the static prompt leaves a meaningful discoverability gap.

## September 10, 2026 update

The shared settings UI now links to `/setup/` instead of rendering the inline instruction card.
`docs/setup.html` owns device/browser setup steps; `SurfaceGuidance.title` remains only as host
context for the popup settings button’s accessible name. Keep browser installation and website
permissions separate from Still account sync: syncing does not install or enable an extension.
The guide is explicitly for Still 2.0; store versions may lag. Publish the guide before installing
clients that link to it, and preserve the GitHub Pages directory URL plus relative asset paths.

### Shared setup destination (owner confirmed 2026-09-10)

Use https://stillapp.fit/setup/ as the canonical setup-help destination across every supported Still surface: Mac app, iPhone/iPad app, Safari extension, Chrome, and Firefox. Existing popup links may open their settings page first, where the guide is linked. Keep device/browser instructions on this shared page so published updates reach installed versions without an app rebuild. Preserve the URL and update its instructions as supported platforms change. The guide does not imply support for native social apps or mobile Chrome/Firefox.
