# Online Still setup guide

Status: implemented; review, publication, and Mac installation in progress. Base: 5bf45de094b1356c9be4e130d795faa48e600372.

Replace the shared inline setup explanation with a simple external link wherever that explanation is currently rendered. Retain settings access from browser popups. Provide a single online Still 2.0 guide with numbered setup steps grouped by device and browser: Mac Safari/Chrome/Firefox, Windows or Linux Chrome/Firefox, iPhone Safari, and iPad Safari. Include per-site permissions, enabling each of the four services, optional account sync, same-browser-profile troubleshooting, and Safari-only mobile scope. No change to blocking/auth behavior.

Use the existing website visual styles and stable /setup/ URL. The page is scoped to Still 2.0 because store releases may lag. Publish only this new guide and its pretty-URL copy; preserve other live website files. Guide wording is grounded in current Apple, Google, and Mozilla support pages linked inline.

Verification: update existing guidance component expectations; full lint/typecheck/unit suite; configured browser and webview builds; existing popup geometry checks; render guide at desktop/mobile widths in both themes; check anchors, links, and external link semantics. Verify live URL before installing a build that links to it. Build/sign/install Mac candidate in place preserving account/settings. Record separately any Apple build/device verification not executed.

Evidence: existing guidance test failed before the change and passes after it; 786 unit tests pass with 39 intentional skips; lint and typecheck pass; configured Chrome, Safari, and webview builds pass; 53 fixture/layout checks pass; guide renders without overflow at 375px and 1000px in both themes, all seven device/browser section anchors resolve. macOS signed build in progress.
