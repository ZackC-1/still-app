# Extension store listing copy — paste-ready

Drafted 2026-07-10 for the 1.0.0 submissions (release commit `22b2717`). Language mirrors the
ASC listing so the product reads identically across stores. Trademark caveat (same as ASC):
"Shorts"/"Reels"/"TikTok" are descriptive use — common in this category, nonzero rejection risk.

---

## Chrome Web Store

**Item name (≤45):** `Still: Block Shorts & Reels`

**Short description (≤132):**

> The scroll, gone. Removes YouTube Shorts free — Instagram Reels, TikTok, and Facebook Reels with Still Pro ($1.99 one-time).

**Category:** Productivity · **Language:** English (US)

**Detailed description:**

> Open YouTube — and the endless short-form feed is just… gone. Still quietly removes Shorts,
> Reels, and TikTok from the sites you already use, so you can open them, do the thing, and get out.
>
> WHAT STILL DOES — FREE
> • Removes YouTube Shorts: the Shorts shelf, the Shorts tab, and Shorts links — a Shorts URL
>   opens in the normal video player instead
> • One switch to turn Still on or off, plus a per-service toggle
> • Works entirely on your device: the free tier sends no data anywhere
>
> STILL PRO — $1.99, ONE TIME
> • Removes Instagram Reels, TikTok, and Facebook Reels
> • Syncs your settings across browsers and devices
> • Purchased securely on the web (opens in a new tab); no subscription, ever
> • Optional email sign-in (a 6-digit code — no password) restores Pro anywhere
>
> PRIVATE BY DESIGN
> • No ads, no tracking, no selling data
> • The free tier never transmits anything; Pro sign-in stores only your email address and
>   synced settings
> • Only runs on youtube.com, instagram.com, tiktok.com, and facebook.com — never your whole
>   browser
>
> Still is made by Cadmus Labs. Still Pro is sold by Cadmus Labs (not Google) as a one-time
> web purchase. Support and refund requests: https://zackc-1.github.io/still-app/support/
> Privacy policy: https://zackc-1.github.io/still-app/privacy/
>
> Less feed. More of your life back.

**Privacy practices tab:**

- Single purpose: `Still removes short-form video feeds (YouTube Shorts; with Still Pro, Instagram Reels, TikTok, and Facebook Reels) from the supported sites.`
- Permission justifications:
  - `declarativeNetRequestWithHostAccess` → `Redirects YouTube Shorts URLs to the standard watch page at the network layer, before the page renders.`
  - `storage` → `Persists the user's on/off and per-service settings locally.`
  - Host permissions (youtube/instagram/facebook/tiktok) → `Applies content rules only on the four sites Still supports; the extension never requests access to other sites.`
- Data usage: check **Authentication information** (email address) and **Website content settings**
  ("user activity"/"personal communications" are NOT collected — do not check them). Certify: data
  is not sold, not used for unrelated purposes, not used for creditworthiness. Free tier transmits
  nothing; disclosure covers the optional Pro sign-in only.
- Remote code: **No** (MV3, fully bundled).

**External payments disclosure (listing + review notes field):**

> Still Pro is a $1.99 one-time purchase completed on the web via RevenueCat/Stripe checkout,
> opened in a new tab from the extension popup. No payment is collected inside the extension.
> The seller is Cadmus Labs.

**Assets needed at upload:** 128×128 icon (in the zip) · ≥1 screenshot 1280×800 · 440×280 small
promo tile.

---

## Firefox Add-ons (AMO)

**Name:** `Still: Block Shorts & Reels` · **Add-on ID (already in manifest):** `still@chartash.com`

**Summary (≤250):**

> Removes short-form video. Free: YouTube Shorts are gone — shelf, tab, and Shorts links open in
> the normal player. Still Pro ($1.99 one-time): also removes Instagram Reels, TikTok, and Facebook
> Reels, and syncs settings. Private by design.

**Description:** reuse the Chrome detailed description verbatim (AMO renders basic HTML/markdown;
the bullet blocks paste cleanly).

**Categories:** Search & Productivity (verify AMO's current category names at submit time).

**License:** the repository LICENSE (do NOT select All Rights Reserved — the public repo ships a
license; AMO listing must match).

**Data collection (must match manifest `data_collection_permissions: ["authenticationInfo"]`):**

> The free tier collects no data and makes no network requests with user data. The optional Still
> Pro sign-in transmits the user's email address (authentication) to our backend (Supabase) solely
> to restore the purchase and sync settings across devices. No browsing activity is collected.

**Availability:** UNCHECK / disable **Firefox for Android** at submission — desktop-only for 1.0.0
(Android enablement is gated on the not-yet-run §B device validation,
`06-mobile-blocking-validation.md`).

**"Requires payment" flag:** check it (free tier is functional, but the listing advertises a paid
upgrade).

**Notes to Reviewer (paste into the source-submission notes):**

> This add-on is built from a pnpm monorepo; the uploaded source zip is the full repository plus
> `packages/ext-chromium/.env` (public Supabase URL + anon key — not secrets). Reproduce the
> exact upload:
>
>   corepack enable && corepack prepare pnpm@11.9.0 --activate   # Node >= 22 (built with v25.4.0)
>   pnpm install --frozen-lockfile
>   pnpm --filter @still/ext-chromium exec wxt zip -b firefox
>
> Output: packages/ext-chromium/dist/stillext-chromium-1.0.0-firefox.zip — the build is
> byte-reproducible across machines and paths.
>
> Functionality: removes YouTube Shorts (free); the paid tier removes Instagram Reels / TikTok /
> Facebook Reels and syncs settings. The Pro purchase happens on the web (RevenueCat checkout in a
> new tab); no payment occurs inside the add-on. The optional sign-in is an emailed 6-digit code;
> the only user data transmitted is the account email (declared as authenticationInfo). Host
> permissions are limited to the four supported sites.

**Assets:** screenshots optional but recommended (same composed shots as Chrome work).

---

## Open item

Neither docs page currently states a purchase/refund policy in plain terms. Before or shortly
after the extension listings go live, add a short "Purchases & refunds" section to
`docs/support.html` (one paragraph: $1.99 one-time via RevenueCat/Stripe; refund requests via
zack@cadmuslabs.co "Find my purchase"; deletion-recovery caveat) so the Chrome listing's
"support and refund requests" link resolves to real policy text.
