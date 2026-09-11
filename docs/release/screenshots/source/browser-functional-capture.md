# Still 2.0 functional browser screenshot capture

Captured September 11, 2026 from the configured 2.0.0 release ZIPs, source commit
`d2b95d99ed10399cd36c86e481286126158047ec`. The Chromium/core runtime is unchanged through
`b9106bd`; the only changed core file in that range is a design-contract test.
This set improves readability and shows separate controls, optional-sync and blocked-page states.
It preserves the [initial free-2 captures](browser-free-2-capture.md).

## Capture conditions

| Browser | Engine | Method |
|---|---|---|
| Chrome | Chromium 153.0.8010.12 | Unmodified unpacked release extension in an isolated headless Playwright context |
| Firefox | Firefox 155.0.1 | Unmodified release ZIP temporarily installed in an isolated headless profile, driven by Marionette |

Every saved PNG is 1280x800 physical pixels, in light mode. The display scale starts at 1.
Native page zoom is 200% for controls, 150% for optional sync and 200% for the TikTok result.
The popup document is opened directly in a tab, without an invented browser frame. Its normal
background fills the viewport. Zoom changes the visible CSS viewport; no application CSS, DOM
text, controls, package files or image pixels were edited. These are direct browser captures,
with no overlays, compositing or post-capture resizing.

Chromium uses its normal page screenshot API after `chrome.tabs.setZoom`. Firefox uses its own
`Capture.sys.mjs` screenshot backend at density matching the native page zoom, with the capture
rectangle equal to the visible content viewport. Marionette's default screenshot returned CSS-pixel
dimensions under zoom; those smaller trial images were rejected. Setting capture density before
Firefox renders the screenshot preserves full physical-pixel resolution. Its temporary density
override is restored after capture. This uses the browser's screenshot renderer, not an image editor.
See Mozilla's [capture implementation](https://searchfox.org/firefox-main/source/remote/shared/Capture.sys.mjs).

## Demonstrated states and limits

1. **Free controls:** signed out, Still on, all four default site controls enabled. The complete
   service rows fit at 200%; the settings-sync section is farther down the actual page. At 175%
   its first sentence was partly cut off, so that trial was rejected. The 125% overview made the
   controls too small at store-thumbnail size.
2. **Optional sync:** open “Sign in to sync,” complete any local data-use disclosure, and stop at
   the real email-entry sheet. The input value is empty; `you@example.com` is placeholder text.
   No code is sent, no account is created and no authentication or completed sync is claimed.
3. **TikTok website blocked:** navigate to `https://www.tiktok.com/` while Still is on. Wait for
   Still's actual `#still-placeholder`, and verify the page text is only “This site is blocked.”
   The saved image contains only Still's logo and message, with no feed, third-party video or
   logged-in content. The product deliberately leaves this page mostly blank. This scene verifies
   that specific navigation, not every supported-site behavior. It does not show native-app blocking.

An independent reviewer inspected both selected browser sets at full size and at 320x200 thumbnail
size. The controls and optional-sync pair passed for readability, complete controls, absence of
paid locks/prices and absence of customer data. The third image passed only as an optional result
with a caption naming the TikTok website; its generic message is insufficient as a standalone
explanation. Use the [upload manifest](../store-ready/README.md) for order and captions.

## Package and screenshot hashes

- Chromium ZIP SHA-256: `c2df39724a2d9c8f9bca640710c86202e469e10e3d4db91074118a3a5c878751`
- Firefox ZIP SHA-256: `339fea7a8a978f4f2302cbb9f92ba5d9b85ea896405bee1d5f16a938aa7ae815`

Both package hashes were rechecked against the release manifest. All 20 unpacked Chromium files
matched the ZIP byte for byte. The Firefox temporary install used the verified ZIP directly.
PNG header checks confirmed all six output dimensions. Chromium emits RGB and Firefox emits RGBA.

| Screenshot | SHA-256 |
|---|---|
| [chrome 01-controls](../store-ready/chrome/still-chrome-functional-01-controls-1280x800.png) | `b5af98ed2cbbec39684d3f5bf62258a6fe6b01a4de6a03e456c52c2b0b9b9330` |
| [chrome 02-sync](../store-ready/chrome/still-chrome-functional-02-sync-1280x800.png) | `3ec11d27c740dc53870fe4910b48d25f986748188dc7bc3272d6b66cbe0e0bb7` |
| [chrome 03-tiktok](../store-ready/chrome/still-chrome-functional-03-tiktok-1280x800.png) | `f762532312ec1b32b32dc744332497d4ce1126a791d398485d08e733b3243b01` |
| [firefox 01-controls](../store-ready/firefox/still-firefox-functional-01-controls-1280x800.png) | `369f016e6da63761a8905a86aac8009d18392da7f9ecd3213b967d15d7c4416c` |
| [firefox 02-sync](../store-ready/firefox/still-firefox-functional-02-sync-1280x800.png) | `544ec4ea76bbeae99ce44454076a735e21aabf53e69abc149b74c806b0e90783` |
| [firefox 03-tiktok](../store-ready/firefox/still-firefox-functional-03-tiktok-1280x800.png) | `07d214d7e5e0eedcafe61a6a012a3b0e1cf7edd1ba72c39eb64cf4193c25e2b0` |

## Refresh procedure

1. Verify the reviewed candidate ZIP hash, then load it in a new isolated browser profile. Do not
   change its manifest, application files, a user's browser profile or an existing store session.
2. Open the installed extension's `popup.html`, with a 1280x800 physical content viewport and light
   mode. Wait for the controls and fonts; leave the account signed out and default controls on.
3. Capture each state above using native page zoom. Do not change application CSS or crop/resize
   the resulting images. Match screenshot density to the browser's current device-pixel ratio;
   verify the saved PNG header rather than assuming the automation reports physical dimensions.
4. Verify the sign-in input remains empty and never press Send code. For the optional TikTok
   result, confirm Still has replaced the page before capturing. Reject any image containing
   customer data or third-party feed content.
5. Review full-size and thumbnail pixels, dimensions, hashes and caption accuracy. Add new
   versioned paths and update the upload manifest; preserve previous sets. Close only the
   capture-owned browser processes.

No runtime code changed for this asset refresh. Scoped verification covers image headers and
hashes, payload identity, documentation links and actual visual review; it does not repeat the
broader release/device test suite. Store uploads and native Apple screenshots are separate work.
The release-wide asset brief also calls for activation and Safari-only mobile visuals. This
browser set does not show installation/permission steps; native Apple captures cover Safari
setup and the mobile boundary. Browser descriptions/captions retain the Safari-only qualification.
This record makes no claim that the full cross-store screenshot brief is complete.
Do not use the legacy `render.mjs` compositor, which embeds archived paid UI.

Related: [store-asset review conventions](../../../solutions/conventions/codify-store-asset-compliance-in-tests.md),
[Chrome image requirements](https://developer.chrome.com/docs/webstore/images), and
[Firefox listing guidance](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/).
