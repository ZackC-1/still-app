# Store-ready screenshot upload manifest

Current browser screenshots were captured September 11, 2026 from the configured Still 2.0.0
release packages. Use the functional assets below. The earlier free-2 captures remain as explicit
baselines. Paid-era screenshots and their duplicate generated copies were removed during the
[repository cleanup](../../../plans/2026-09-14-repository-file-cleanup.md); Git history preserves them.

## Apple App Store — iPhone, iPad and Mac

Keep the owner-approved screenshots already submitted with build 8 in App Store Connect. Their
release state and local evidence are recorded in the [September 14 release status](../../2026-09-14-release-status.md).
No native screenshot or store submission was replaced during repository cleanup.

The former six-image `iphone/`, `ipad/` and `macos/` sets were paid-era marketing concepts with
third-party service marks, explicitly excluded from current uploads. They have been removed.
Future Apple screenshots must come from the actual candidate, reflect the free release, and receive
visual/rights review. Browser captures do not stand in for native Apple screenshots.

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
- The older paid-UI screenshot and annotated Firefox concepts have been removed. Preserve
  `still-firefox-free-2-1280x800.png` as a baseline.

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

Refresh functional screenshots from the actual candidate in an isolated browser and review the
resulting pixels before replacing a submitted image. `source/render.mjs` now renders only brand
assets: `store-promo` writes the two Chrome tiles here, `iap` writes the retained IAP image here,
and `promo` writes the website sharing image at its existing `../v2/web/` URL. Each has one output
copy. An unscoped run renders those four brand images; it never rewrites functional screenshots.

Official screenshot guidance: [Chrome](https://developer.chrome.com/docs/webstore/images) and
[Firefox](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/).

## Still Pro in-app purchase image

**Retained historical asset, not a free 2.0.0 upload instruction.** Do not re-add a promoted purchase
image or replace current reviewer material merely because the July note below mentions a future
retry. The September 14 record supersedes that old next action. Current review notes explain the
free functionality and retained product; use the actual submitted free UI if new private review
material is specifically requested.

For a separately approved future paid submission, use `apple/still-pro-iap-v3-1024x1024.jpg` only in the public promotional **Image** field for the
in-app purchase. This section is the CANONICAL statement of the compliance rules — the release
runbook §7 references it rather than restating it.

> **Status 2026-07-16: NOT currently uploaded — the field is empty by choice.** App Store Connect
> would not process this asset (broken-placeholder thumbnail in both JPEG and PNG, across Chrome,
> Incognito, and Safari; file, extensions, and network all ruled out). The image is Optional and
> Apple's rejection letter offers deletion as a remedy, so the field was cleared to get a clean
> 2.3.2 resolution rather than ship a half-processed asset. v3 is staged here for a post-approval
> retry — promoted-IAP metadata is version-independent, so re-adding it costs no review cycle.
> Full detail: [historical Apple runbook](../../../archive/pre-2.0-reference-refresh/docs/release/01-apple-app-store.md) §7 step 6.

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
  - Regenerate ONLY via `node render.mjs iap` from `../source/` so unrelated brand assets remain
    untouched.

This is not the **App Review Screenshot**. For that separate review-only field, capture the real
Still Pro purchase/paywall screen only for a future paid candidate where that UI actually exists.
The free 2.0.0 build has no purchase requirement; do not fabricate a paywall screenshot.

## Rights and accuracy check before each upload

Before a future upload, confirm the live build matches the depicted interface and review rights
for every material shown. Use the approved native Apple captures for Apple listings and the
functional browser captures for Chrome/AMO. Removed historical concepts are not upload candidates.
