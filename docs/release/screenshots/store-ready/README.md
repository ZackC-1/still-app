# Store-ready screenshot upload manifest

Verified against the official store requirements on July 13, 2026. Upload assets from this directory,
not from `../v2/`. The `v2` directory remains the complete marketing-concept set for the website,
support material, and future campaigns.

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

Upload the five numbered `still-chrome-v2-*` files in numeric order. Do not add a sixth screenshot;
Chrome accepts at most five.

- Screenshots: 5 JPEG files at 1280x800, full bleed
- Small promo tile: `chrome/still-chrome-promo-v2-440x280.jpg` (required)
- Marquee tile: `chrome/still-chrome-marquee-v2-1400x560.jpg` (optional, recommended)
- The promo tiles are brand-led and omit marketing copy, following Chrome's recommendation to avoid
  text in promotional images.

## Firefox Add-ons (AMO)

Upload only `firefox/still-firefox-store-01-1280x800.jpg`.

- Format: JPEG
- Dimensions: 1280x800 (Mozilla's maximum display size and recommended 1.6:1 ratio)
- Content: actual add-on UI with no explanatory text baked into the image
- Put the benefit explanation in AMO's screenshot-description field. Do not upload the annotated
  `../v2/firefox/` concepts to AMO.

## Still Pro in-app purchase image

Use `apple/still-pro-iap-v2-1024x1024.jpg` only in the public promotional **Image** field for the
in-app purchase.

- Format: JPEG
- Dimensions: 1024x1024
- Color: RGB
- Density: 72 dpi
- Flattened with square image corners

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
