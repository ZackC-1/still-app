# Store listing copy — canonical launch version

Updated 2026-07-13. This is the paste-ready source of truth for the English U.S./Canada launch.
The message order is intentional: outcome → free value → Pro value → cross-platform proof → scope →
privacy. Do not reorder the native-app limitation below the privacy/footer material.

## Shared product language

- Brand promise: **Open for what you came for.**
- Functional proof: **Still removes short-form video from supported browsers.**
- Free: **YouTube Shorts are removed free. No account required.**
- Pro: **$1.99 once. No subscription. Removes Instagram/Facebook Reels, blocks the TikTok website,
  and syncs settings.**
- Cross-platform: **One purchase unlocks Still Pro on every supported surface after sign-in with the
  same email.**
- Mobile disclosure: **On iPhone and iPad, Still works only in Safari. It does not change native
  YouTube, Instagram, Facebook, or TikTok apps. Chrome on mobile is not supported.**

Never shorten “every supported surface” to “everywhere.”

---

## Chrome Web Store

**Item name (≤45):**

> Still: Block Shorts & Reels

**Short description (≤132):**

> Block YouTube Shorts free. Pay $1.99 once for Reels, TikTok, and synced settings across supported browsers and devices.

**Category:** Productivity

**Detailed description:**

> OPEN FOR WHAT YOU CAME FOR
>
> You opened the site to do one thing. Still helps it stay one thing.
>
> Still removes short-form video from the websites you already use, so a useful visit does not turn
> into an accidental hour of scrolling. The rest of each site stays available.
>
> START FREE
> • Removes the YouTube Shorts shelf and tab
> • Opens Shorts links in the normal video player
> • No account required
> • Blocking and settings stay on your device
>
> STILL PRO — $1.99 ONCE, NO SUBSCRIPTION
> • Removes Instagram Reels and Facebook Reels
> • Blocks the TikTok website
> • Syncs your Still settings across supported browsers and devices
> • One purchase on any surface unlocks Still Pro on every supported surface after you sign in with
>   the same email
>
> WHERE STILL WORKS
> • Desktop: Chrome and Firefox
> • Apple devices: Safari on iPhone, iPad, and Mac
> • On iPhone and iPad, Still works only while browsing websites in Safari
>
> IMPORTANT: Still does not remove or block short-form video inside native mobile apps such as the
> YouTube, Instagram, Facebook, or TikTok apps. Chrome on mobile does not support Still.
>
> PRIVATE BY DESIGN
> • No ads, behavioral tracking, or browsing-history analytics
> • Free blocking runs entirely on your device
> • Pro sign-in stores only the account, purchase entitlement, and Still settings needed for restore
>   and sync
> • Still runs only on youtube.com, instagram.com, tiktok.com, and facebook.com
>
> Still Pro checkout opens securely on the web and is sold by Cadmus Labs. Support and refunds:
> https://zackc-1.github.io/still-app/support.html
>
> Open for what you came for. Leave with your attention intact.

**Privacy practices — single purpose:**

> Still removes short-form video feeds from supported websites so users can browse those sites
> without Shorts, Reels, or TikTok pulling them into an endless feed.

**Permission justifications:**

- `declarativeNetRequestWithHostAccess`: Redirects YouTube Shorts URLs to the standard watch page
  before the Shorts player renders.
- `storage`: Saves the user's on/off, per-service, pause, sign-in, and entitlement state.
- Host permissions: Applies Still's blocking rules only on YouTube, Instagram, Facebook, and TikTok.

**Data disclosure:** Authentication information is used only for optional Pro sign-in, purchase
restore, and settings sync. Do not declare browsing history, page content, personal communications,
or ad data; Still does not collect them. Remote code: **No**.

**External payment disclosure:**

> Still Pro is a $1.99 one-time purchase completed on the web through RevenueCat and Stripe. Checkout
> opens in a new tab; no payment is collected inside the extension. The seller is Cadmus Labs.

**Recommended asset order:** upload exactly the five numbered screenshots in
`screenshots/store-ready/chrome/` in numeric order. Chrome accepts no more than five screenshots.
Also upload the 440x280 small promo tile and the optional 1400x560 marquee tile from that folder.
Keep screenshot 05; it is the expectation-setting screen that reduces mismatched installs and refunds.

---

## Firefox Add-ons (AMO)

**Name:**

> Still: Block Shorts & Reels

**Summary (≤250):**

> Open for what you came for. Remove YouTube Shorts free; Still Pro ($1.99 once) removes Reels, blocks TikTok, and syncs settings across supported browsers. Desktop Firefox only. On mobile, Still works only in Safari—not native apps.

**Description:** use the Chrome detailed description above.

**Categories:** Productivity and Privacy & Security, if those exact labels remain available.

**License:** use the repository's actual source-available license selection; do not describe the
project as open source.

**Data collection disclosure:**

> The free tier collects no data and makes no network requests with user data. Optional Still Pro
> sign-in sends the user's email address to Supabase only to restore the purchase and sync Still
> settings across supported devices. Still does not collect browsing history or website content.

**Payment flag:** Mark that the add-on contains/requires payment for premium functionality while
stating that YouTube Shorts blocking remains usable for free.

**Reviewer note:**

> This add-on is built from a pnpm monorepo. Reproduce the submitted build with Node 22+ and pnpm
> 11.9.0: `pnpm install --frozen-lockfile`, then `pnpm --filter @still/ext-chromium exec wxt zip -b
> firefox`. The free tier removes YouTube Shorts. Still Pro is a $1.99 one-time web purchase that
> removes Instagram/Facebook Reels, blocks the TikTok website, and syncs settings. Checkout opens in
> a browser tab; no payment occurs inside the add-on. Optional sign-in uses an emailed 6-digit code.
> The only user identifier transmitted is the account email declared as authentication information.
> Host permissions are limited to the four supported websites.

**Recommended asset:** upload
`screenshots/store-ready/firefox/still-firefox-store-01-1280x800.jpg`. It shows the actual add-on UI
without explanatory text baked into the image, following Mozilla's current listing guidance. Use the
listing's screenshot-description field for any explanation rather than uploading the annotated
`screenshots/v2/firefox/` marketing concepts.

**Screenshot description:**

> Still removes short-form feeds while keeping the useful parts of each site available. YouTube
> Shorts blocking is free; Still Pro adds Reels, TikTok, and settings sync.

---

## Response templates for reviews and support

**“It does not work in the Instagram/YouTube app.”**

> Thanks for trying Still. On iPhone and iPad, Still works only on websites opened in Safari; Apple
> does not let a Safari extension modify native social-media apps. We state this on the listing and
> compatibility screen, but I am sorry it did not match what you expected. Refund instructions are
> at https://zackc-1.github.io/still-app/support.html.

**“My Pro purchase is missing on another device.”**

> Sign in to Still on both devices with the same email used for the purchase. One purchase unlocks
> Still Pro on every supported surface tied to that account. If it still does not appear, email the
> purchase receipt address to zack@cadmuslabs.co and we will reconnect it.

**Positive review response:**

> Thank you for making Still part of your browser. We are glad it helps you open for what you came
> for and leave with your attention intact.
