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
