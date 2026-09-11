# Still 2.0 browser screenshot capture

Captured September 11, 2026 from the configured 2.0.0 release ZIPs. Source commit:
`d2b95d99ed10399cd36c86e481286126158047ec`. Browser application code is unchanged through
`f6d70825156548239666134d1b49f3d0d75af8a7`.

## Evidence

| Browser | Engine | Capture |
|---|---|---|
| Chrome | Chromium 153.0.8010.12 | Release unpacked extension in an isolated persistent Playwright context |
| Firefox | Firefox 155.0.1 | Release ZIP temporarily installed in an isolated profile; Marionette capture |

Both PNGs are 1280x800 at device scale factor 1, light mode, and normal application CSS sizing.
The popup document is opened directly rather than placed in a simulated toolbar frame. Its normal
white page background fills the viewport. The images were captured by the browser without pixel
editing or overlays. Firefox has an RGBA PNG; Chromium has an RGB PNG.

Visual review confirmed all four controls on, no Pro locks or purchase button, and sign-in offered
only for settings sync. Neither browser was signed in. No account was created, authenticated,
exported or deleted. This capture verifies presentation, not supported-site blocking or sync.
The Chromium popup reported no page errors. All 20 loaded Chromium payload files matched the
release ZIP byte for byte; both ZIP hashes matched the release manifest.

### Chrome hashes

- ZIP SHA-256: `c2df39724a2d9c8f9bca640710c86202e469e10e3d4db91074118a3a5c878751`
- Screenshot: [`still-chrome-free-2-1280x800.png`](../store-ready/chrome/still-chrome-free-2-1280x800.png)
- PNG SHA-256: `365aabbdd5939e90e1d2cd95bc4bed4c8720a05d84a3605c9cfbd08370339c2d`

### Firefox hashes

- ZIP SHA-256: `339fea7a8a978f4f2302cbb9f92ba5d9b85ea896405bee1d5f16a938aa7ae815`
- Screenshot: [`still-firefox-free-2-1280x800.png`](../store-ready/firefox/still-firefox-free-2-1280x800.png)
- PNG SHA-256: `8fea626642aaca9a30c6d7f8b750f0c9be129a621f31460751960552514f58fa`

## Refresh procedure

1. Select the reviewed configured release ZIP and verify its hash. Use a new isolated browser
   profile, with no existing customer settings or account session.
2. Load the unpacked Chromium ZIP into Chromium, or temporarily install the Firefox ZIP in Firefox.
   Preserve the original manifest and application files. Open that extension's `popup.html` document.
3. Use a 1280x800 content viewport, light mode and device scale factor 1. Wait for the real controls
   and fonts to finish loading. Leave the account signed out and the four default controls enabled.
4. Capture the content viewport directly as PNG. Verify dimensions, account-free content, readable
   controls, and absence of purchase requirements. Record the browser version and package/image
   hashes; do not record extension session IDs or private profile paths in public documentation.
5. Add a new versioned asset, update the upload manifest, and review the actual image before upload.
   Close only the capture-owned browser process. Keep older assets for history until a separate
   cleanup is approved.

The older `render.mjs` is a marketing compositor whose browser source is the archived paid popup.
Running it does not refresh these real UI captures. Apple requires a separate capture from the
candidate native app; these browser images do not stand in for iPhone, iPad or Mac screenshots.

Related: [upload manifest](../store-ready/README.md),
[store-asset review conventions](../../../solutions/conventions/codify-store-asset-compliance-in-tests.md),
[Chrome image requirements](https://developer.chrome.com/docs/webstore/images), and
[Firefox listing guidance](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/).
