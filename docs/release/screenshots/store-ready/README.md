# Store-ready screenshots: Still 2.1 upload manifest

Everything in this folder is ready to upload, one folder per store. Upload the files **in the order
listed**; the first three are the ones people see in search results. Every image is an exact store
size, checked by `tests/playwright/showcase-frames.spec.ts` together with the listing's accuracy
rules (never "everywhere", "forever" or "no tracking").

| Folder | Store | Size | Count |
|---|---|---|---|
| [`iphone/`](iphone/) | App Store, iPhone 6.9" (Apple scales it down for smaller iPhones) | 1320×2868 | 7 |
| [`ipad/`](ipad/) | App Store, iPad 13" | 2064×2752 | 3 |
| [`mac/`](mac/) | Mac App Store | 2880×1800 | 6 |
| [`chrome/`](chrome/) | Chrome Web Store (plus the two promo tiles) | 1280×800 | 5 |
| [`firefox/`](firefox/) | Firefox Add-ons (AMO) | 1280×800 | 5 |
| [`instagram/`](instagram/) | Instagram feed posts (not a store) | 1080×1350 | 3 |
| [`apple/`](apple/) | Retained in-app purchase image, see the last section | 1024×1024 | 1 |

The 2.0 functional captures and the v3 captioned set are in [`../archive/2.0/`](../archive/2.0/).
They are history, not upload candidates.

## Apple App Store — iPhone, iPad and Mac

Upload with the Apple 2.1.0 version. Apple has no caption fields; the words are in the images.

**iPhone** (`iphone/`), in order:
1. `iphone-01-youtube`: YouTube "side hustle" Shorts in Safari at 1:47 AM, crossed out, then gone
2. `iphone-02-instagram`: an Instagram Reels page in Safari, cleared away
3. `iphone-03-switches`: the Still app, one switch per site
4. `iphone-04-facebook`: a Facebook Reels page in Safari, cleared away
5. `iphone-05-tiktok`: the TikTok website, blocked
6. `iphone-06-safari-menu`: Still's menu open in Safari over the YouTube search
7. `iphone-07-setup`: the "Turn on Still in Safari" setup screen, with "not inside other apps"

**iPad** (`ipad/`): `ipad-01-safari-popup` (Still in Safari's toolbar over Supercar Blondie's Instagram, 1:47 AM),
`ipad-02-switches`, `ipad-03-setup`.

**Mac** (`mac/`): `mac-01-youtube`, `mac-02-instagram`, `mac-03-facebook`, `mac-04-tiktok`,
`mac-05-app` (the Still Mac app), `mac-06-chrome` (Still's popup in Chrome's toolbar).

## Chrome Web Store

Upload in order, all 1280×800: `chrome-01-youtube`, `chrome-02-instagram`, `chrome-03-facebook`,
`chrome-04-tiktok`, `chrome-05-switches`. Chrome allows five. Keep the promo tiles:
`still-chrome-promo-v2-440x280.jpg` (required) and `still-chrome-marquee-v2-1400x560.jpg`.

## Firefox Add-ons (AMO)

Upload in order, all 1280×800, with these captions in AMO's description fields:

| File | Caption |
|---|---|
| `firefox-01-youtube` | Shorts are removed from YouTube. Your videos, search and subscriptions stay. |
| `firefox-02-instagram` | The Reels tab and the Reels in your feed are removed from Instagram. |
| `firefox-03-facebook` | Facebook Reels are cleared away. Pages, posts and friends stay. |
| `firefox-04-tiktok` | The TikTok website is blocked while Still is on. This does not block the TikTok app. |
| `firefox-05-switches` | One switch per site, from Still's button in Firefox's toolbar. |

## How these were made

All pictures are real captures of the Still 2.1.0 build with rule set 1.1.11, which includes both
Facebook fixes (#213 and #218). The "before" shots show real attention bait: money hooks on YouTube
and TikTok, supercars on Instagram, and a Facebook feed's Reels shelf. Red circles and X's mark only
what Still removes. Phone Safari shots show 1:47 AM.

Which content was chosen and why, what was rejected, and step-by-step instructions to remake any
image are in [`../source/frames/README.md`](../source/frames/README.md).

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

- The live build matches the pictured interface (2.1.0 for these files).
- Service logos identify the site Still changes and imply no endorsement; sources are in
  `../source/frames/logos/README.md`. Replace them if a reviewer or trademark owner objects.
- Faces and pages shown are public accounts' published content; no private person's name,
  message or account appears. Recheck any recapture before uploading it.
- Phones mean Safari only; say "every supported surface", never "everywhere".
