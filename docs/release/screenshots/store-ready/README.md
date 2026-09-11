# Store-ready screenshot upload manifest

Current browser screenshots: captured September 11, 2026 from the configured Still 2.0.0 release
packages. Use the named functional assets below. The earlier free-2 captures remain as baselines.
The older `v2` screenshots and renderer include paid 1.x UI/copy and are retained as historical concepts, not current 2.0 upload assets. Apple guidance
below remains separate; the browser captures do not validate native screenshots.

## Apple App Store — iPhone

Do **not** upload the current six files in `iphone/` to App Store Connect. They are useful marketing
concepts, but they visibly include third-party service marks and are therefore not the approved
Apple upload set. Keep the already-submitted, brand-safe Apple screenshots in place while review is
pending. Before a future Apple metadata update, create and rights-review brand-safe variants that
show the real Still UI without those marks.

- Format: JPEG
- Dimensions: 1290x2796 portrait
- Count: 6 (Apple accepts 1–10)
- Content: every image includes the app in use; images 5 and 6 use text/image overlays while retaining
  the actual app interface
- Pricing: no hard-coded price, so the English set is safe for both U.S. and Canadian storefronts

## Apple App Store — iPad

Do **not** upload the current six files in `ipad/` to App Store Connect for the same third-party
service-mark reason as the iPhone set. Keep the currently submitted brand-safe screenshots in place
while review is pending; use rights-reviewed brand-safe variants for any future update.

- Format: JPEG
- Dimensions: 2064x2752 portrait
- Count: 6
- Content: every image includes the app in use

## Mac App Store

Do **not** upload the current six files in `macos/` to App Store Connect for the same third-party
service-mark reason as the iPhone set. Keep the currently submitted brand-safe screenshots in place
while review is pending; use rights-reviewed brand-safe variants for any future update.

- Format: JPEG
- Dimensions: 2880x1800 landscape (16:10)
- Count: 6
- Content: every image includes the app in use

## Chrome Web Store

Upload these RGB PNGs in order, both 1280x800:

1. [`still-chrome-functional-01-controls-1280x800.png`](chrome/still-chrome-functional-01-controls-1280x800.png): all four free controls enabled, signed out.
2. [`still-chrome-functional-02-sync-1280x800.png`](chrome/still-chrome-functional-02-sync-1280x800.png): optional settings-sync sign-in, with an empty email field.

Remove older screenshots depicting Pro locks, purchase requirements or paid sync from the 2.0
listing. The previous `still-chrome-free-2-1280x800.png` remains a historical baseline.

- Browser: Chromium 153.0.8010.12, isolated profile with the release extension loaded
- Small promo tile: `chrome/still-chrome-promo-v2-440x280.jpg` (required)
- Marquee tile: `chrome/still-chrome-marquee-v2-1400x560.jpg` (optional, recommended)
- The promo tiles are brand-led and omit marketing copy, following Chrome's recommendation to avoid
  text in promotional images.

## Firefox Add-ons (AMO)

Upload these PNGs in order, all 1280x800:

1. [`still-firefox-functional-01-controls-1280x800.png`](firefox/still-firefox-functional-01-controls-1280x800.png): “Remove Shorts and Reels and block the TikTok website for free. No account required.”
2. [`still-firefox-functional-02-sync-1280x800.png`](firefox/still-firefox-functional-02-sync-1280x800.png): “Sign in optionally for free settings sync between supported computer browsers and Safari on iPhone or iPad through the Still iOS app. Install Still separately and use the same account.”
3. Optional: [`still-firefox-functional-03-tiktok-1280x800.png`](firefox/still-firefox-functional-03-tiktok-1280x800.png), with the caption: “The TikTok website is blocked while Still is on. This does not block the native TikTok app.”

Put these captions in AMO's screenshot-description fields. The blocked page itself says only
“This site is blocked,” so its caption is required to identify the demonstrated website.

- Browser: Firefox 155.0.1, isolated profile with the release ZIP temporarily installed
- No explanatory text or invented browser chrome is baked into the images
- Remove the older paid-UI `still-firefox-store-01-1280x800.jpg`; do not upload annotated
  `../v2/firefox/` concepts. Preserve `still-firefox-free-2-1280x800.png` as a baseline.

## Browser capture provenance and refresh

The [release-wide screenshot brief](../../marketing-playbook.md#assets-and-publication) spans browser
and native Apple surfaces. This browser sequence covers free controls, optional sync and the
optional TikTok result. It does not picture browser installation/permission steps. Safari setup
and the Safari-only mobile boundary belong to the separate native Apple capture set; keep that
boundary explicit in browser listing descriptions and captions too. These files do not certify
complete cross-store screenshot coverage or replace review of the Apple set.

The controls view uses 200% native browser zoom; the optional-sync view uses 150%; the TikTok
result uses 200%. The content viewport remains 1280x800 physical pixels. The popup document is
opened directly, with its real white background. All four controls fit in the first capture;
settings farther down the real page remain below the fold. The second capture shows the real
sign-in sheet and an empty email input; `you@example.com` is its existing placeholder.

Both sets were independently reviewed at full size and thumbnail size. They include no customer
data, simulated controls, pixel editing or marketing overlays. Native browser rendering differs
slightly between engines. See [capture evidence and refresh procedure](../source/browser-functional-capture.md)
for package and image hashes, screenshot-density details and verification limits. The portal
upload status is separate from this asset record. These images do not demonstrate completed sync
or native-app blocking; keep supported browser surfaces clear in the listing description.

Do not regenerate these files through `source/render.mjs`: that older compositor embeds the
archived `chrome/raw-popup-v2.png`. Refresh from the actual candidate in an isolated browser and
review the resulting pixels before replacing a submitted image.

Official screenshot guidance: [Chrome](https://developer.chrome.com/docs/webstore/images) and
[Firefox](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/).

## Still Pro in-app purchase image

Use `apple/still-pro-iap-v3-1024x1024.jpg` only in the public promotional **Image** field for the
in-app purchase. This section is the CANONICAL statement of the compliance rules — the release
runbook §7 references it rather than restating it.

> **Status 2026-07-16: NOT currently uploaded — the field is empty by choice.** App Store Connect
> would not process this asset (broken-placeholder thumbnail in both JPEG and PNG, across Chrome,
> Incognito, and Safari; file, extensions, and network all ruled out). The image is Optional and
> Apple's rejection letter offers deletion as a remedy, so the field was cleared to get a clean
> 2.3.2 resolution rather than ship a half-processed asset. v3 is staged here for a post-approval
> retry — promoted-IAP metadata is version-independent, so re-adding it costs no review cycle.
> Full detail: `docs/release/01-apple-app-store.md` §7 step 6.

- Format: JPEG, RGB, 1024x1024, 72 dpi, flattened with square image corners
- Rejection history: v1 (an app paywall screenshot showing the price) was rejected under
  Guideline 2.3.2 on July 16, 2026 — a screenshot with small text AND a price reference. v2 (brand
  card with a small subline) was never uploaded and is retired; git history preserves both.
- Compliance rules — the SOURCE-level rules are pinned in CI by
  `tests/playwright/store-assets.spec.ts` (which also checks the committed JPEG's dimensions);
  the shipped JPEG's visual content still requires the human render + sign-off step in runbook §7:
  - Unique artwork: never an app screenshot, and never resembling the app icon — Apple composites
    the real app icon into the lower-left of search placements, so repeating its motif reads as
    "confusable with your app icon."
  - No price text or price-shaped strings anywhere in the image.
  - Text limited to the product name at ≥ 12% of the canvas height, so it survives the ~120px
    thumbnail scale Apple renders in search.
  - The bottom-left 30% × 30% of the canvas stays content-free (internal convention — Apple
    publishes no exact figure — reserving the icon-composite region).
  - Regenerate ONLY via `node render.mjs iap` from `../source/` — an unscoped run rewrites the
    rights-reviewed screenshot sets above.

This is not the **App Review Screenshot**. For that separate review-only field, capture the real
Still Pro purchase/paywall screen from the submitted build so the item being sold is visible.

## Rights and accuracy check before each upload

The screenshots reproduce the actual Still interface, including third-party service names and icons.
Apple requires the publisher to hold the rights needed for every material shown in screenshots. The
current Apple-family files in this directory are **not** cleared for App Store upload because they
include those service marks. Before uploading any future Apple screenshots, confirm the live build
still matches the depicted interface, obtain any required rights clearance, or use brand-safe UI
crops that do not show the marks. Chrome and AMO assets must also be checked against each store's
current third-party-rights and accuracy rules.
