# Still launch marketing system — English U.S. and Canada

This is the canonical acquisition and conversion plan for the first launch. It covers App Store
Connect (iOS and macOS), Chrome Web Store, Firefox Add-ons, the homepage, support, product onboarding,
screenshots, review prompts, release notes, and organic-growth operations.

## 1. Objective function and funnel

The optimization order is:

1. **Qualified initial downloads.** Win the search result and product-page visit with a clear problem,
   a calm future state, and immediate free value.
2. **Still Pro conversion.** Once the user trusts the free YouTube result, show the broader quiet-web
   outcome, the $1.99 one-time price, cross-platform entitlement, and sync.
3. **Expectation quality as a guardrail.** Never increase downloads by implying native-app blocking.
   A qualified install with accurate scope is worth more than a larger number of refund-prone installs.

Use these funnel KPIs rather than raw traffic alone:

| Funnel stage | Primary metric | Guardrail |
|---|---|---|
| Store search | Product-page views / impressions | Search-term relevance |
| Product page | First-time downloads / product-page views | Uninstall rate; low-star scope complaints |
| Activation | Extension enabled + YouTube blocking working | Setup/support failure rate |
| Pro | Pro purchasers / activated users | Refund rate; purchase-restore failures |
| Retention | Active installs and low uninstall rate | Privacy/support complaints |

Chrome explicitly says its ranking heuristic uses user ratings and usage signals including downloads
versus uninstalls. That makes honest qualification and successful onboarding part of organic discovery,
not merely customer support. Apple likewise says ratings and reviews can influence search ranking and
conversion.

## 2. Positioning

### Category

Still is a **short-form video remover for the web**, not a generic website blocker, parental-control
tool, screen-time dashboard, or willpower system.

### Job to be done

> When I open a social or video website for one specific reason, help me complete that purpose without
> being pulled into a short-form feed, so I can leave with my attention and time intact.

This follows Jobs-to-be-Done research: people “hire” products to make progress in a circumstance, and
the job includes emotional dimensions—not only functionality. The future state is **a browser that
feels quiet enough to use intentionally**.

### Audience

- Primary: adults who deliberately use YouTube or social websites but regret accidental short-form
  scrolling.
- High-intent searchers: people searching for “block YouTube Shorts,” “remove Shorts,” “hide Reels,”
  “block TikTok,” “doomscrolling,” “focus,” or “digital wellbeing.”
- Cross-platform converter: someone who browses on a desktop and iPhone/iPad and wants one purchase
  and one consistent set of preferences.

### Brand promise

> **Open for what you came for.**

### Supporting line

> Still removes short-form video from supported browsers, so one intentional visit does not become an
> hour of scrolling.

### Product proof

> YouTube Shorts are removed free. Still Pro is $1.99 once for Instagram/Facebook Reels, the TikTok
> website, and synced settings across supported browsers and devices.

### Scope statement

> On iPhone and iPad, Still works only in Safari. It does not change native YouTube, Instagram,
> Facebook, or TikTok apps. Chrome on mobile is not supported.

Never use these claims without qualification: “blocks everywhere,” “works in every app,” “all your
devices,” “all platforms,” “dopamine detox,” “addiction treatment,” or guaranteed mental-health or
productivity outcomes. Prefer “supported browsers and devices.”

## 3. Message hierarchy across every touchpoint

Every surface uses the same six beats in this order:

| Beat | Message | Funnel role |
|---|---|---|
| 1 | Open for what you came for. | Emotional differentiation; earns the click/download |
| 2 | YouTube Shorts. Gone for free. | Removes adoption risk |
| 3 | More sites. One calm web. | Creates desire for Still Pro |
| 4 | One purchase. Every supported screen. | Justifies purchase and differentiates Still |
| 5 | Mobile means Safari. Native apps are not blocked. | Qualifies expectations and protects refunds |
| 6 | Still does not need to watch you. | Resolves trust/privacy objection |

The detailed feature list is evidence underneath these outcomes, not the headline.

## 4. Apple App Store metadata — iOS and macOS

Use the same identity and message hierarchy on both platform pages. Screenshots differ by device, but
the captions and order remain identical.

**Name (30-character limit):**

> Still: Block Shorts & Reels

**Subtitle (30-character limit):**

> Keep your attention in Safari

**Promotional text (170-character limit; editable without a new version):**

> Open Safari for what you came for—not an accidental scroll. Remove YouTube Shorts free; Still Pro quiets Reels and TikTok and syncs your settings.

**Keywords (100-character limit):**

> focus,distraction,doomscroll,digital wellbeing,screen time,attention,productivity,mindful,feed

Do not place competitor names or third-party trademarks in the keyword field. Apple warns against
unauthorized trademark terms and says promotional text does not influence search ranking.

**Description:**

> Open for what you came for—and leave when you are done.
>
> Still removes short-form video from the websites you use in Safari. You keep normal videos, posts,
> messages, and pages; the feeds designed to pull you into one more clip simply disappear.
>
> START FREE
> • Remove the YouTube Shorts shelf and tab
> • Open Shorts links in the normal video player
> • No account required
> • Blocking happens on your device
>
> STILL PRO — ONE PURCHASE, NO SUBSCRIPTION
> • Remove Instagram Reels and Facebook Reels
> • Block the TikTok website
> • Sync your Still settings across supported browsers and devices
> • Sign in with the same email to unlock Pro on every supported surface
>
> WHERE STILL WORKS
> • Safari on iPhone, iPad, and Mac
> • Still Pro can also be used with Still for Chrome and Firefox on desktop
>
> IMPORTANT: On iPhone and iPad, Still works only while you browse these websites in Safari. It does
> not remove or block short-form video inside native mobile apps such as the YouTube, Instagram,
> Facebook, or TikTok apps. Chrome on mobile does not support Still.
>
> PRIVATE BY DESIGN
> • No ads, behavioral tracking, or browsing-history analytics
> • Free blocking and local settings stay on your device
> • Pro sign-in stores only the account, purchase entitlement, and Still settings needed for restore
> and sync
>
> No timers. No streaks. No shame. Just a calmer browser.

Apple advises against including a fixed price in the description because localized pricing is already
shown on the product page. Keep “one purchase, no subscription” here and let the IAP surface display
the local price.

**Still Pro IAP display name:**

> Still Pro

**IAP description (55-character limit):**

> Block Reels and TikTok, and sync across devices.

**What’s New — 1.0:**

> Still is here. Remove YouTube Shorts free, then unlock Still Pro to quiet Reels and TikTok and sync
> your settings across supported browsers and devices. On mobile, Still works in Safari only.

**Screenshot order:** upload `screenshots/store-ready/iphone/*`,
`screenshots/store-ready/ipad/*`, and `screenshots/store-ready/macos/*` in numeric order. The first
three prioritize download and Pro desire; image 05 gives the mobile limitation its own unmissable
frame. Every Apple screenshot in these folders includes the app in use.

## 5. Chrome and Firefox metadata

Paste from [store-listing-copy.md](./store-listing-copy.md). Its wording is aligned with the Apple
description while retaining the exact $1.99 web price allowed and useful on extension storefronts.

## 6. Homepage

The live-page replacement is [docs/index.html](../index.html) with styles in
[docs/assets/marketing.css](../assets/marketing.css). It implements the same funnel:

1. Outcome headline and Chrome CTA.
2. Free price proof directly beneath the CTA.
3. Emotional future-state section.
4. Functional service proof.
5. Free-versus-Pro comparison.
6. Cross-platform entitlement and explicit compatibility matrix.
7. Mobile/native-app limitation in a high-contrast notice.
8. Privacy proof and final CTA.

The homepage now links directly to the published Chrome Web Store listing. Add the Apple and Firefox
direct links after approval; do not point launch CTAs at review/pending pages.

## 7. Screenshot system and finished assets

Finished JPEGs live under `docs/release/screenshots/v2/`:

- Chrome: 6 × 1280×800
- Firefox: 6 × 1280×800
- macOS: 6 × 2880×1800
- iPhone: 6 × 1290×2796
- iPad: 6 × 2064×2752

The deterministic source is `screenshots/source/index.html`; regenerate with:

```bash
node docs/release/screenshots/source/render.mjs
```

This is intentionally HTML/CSS composition over the real UI captures. Generative imagery is a poor
fit for store screenshots because it can distort UI, misspell copy, or imply unsupported behavior.

The screenshots use the same six captions on every platform. Do not create platform-specific slogans
unless a measured test shows a meaningful conversion gain.

## 8. Organic discovery playbook

### Apple App Store

- Put the high-intent functional terms in the name: “Block Shorts & Reels.” Apple says the name is
  critical to discovery, and the first one to three screenshots can appear in search results.
- Use the subtitle for outcome plus scope: “Keep your attention in Safari.”
- Use all 100 keyword characters without duplicating name/subtitle words. Start with the supplied
  hypotheses, then change only after enough impression/search data exists.
- Use the first three screenshots as a miniature funnel: desired state, free proof, Pro future state.
- After initial volume, run Product Page Optimization on **one variable at a time**: first screenshot
  headline first; subtitle second. Do not test a new icon, headline, and ordering simultaneously.
- Ask for a rating only after a success moment: extension enabled, at least seven days since install,
  and the user has returned to Still voluntarily. Never prompt immediately after purchase or an error.
- Respond to every substantive review. Scope complaints get the honest Safari-only response and a
  refund path, not a defensive feature explanation.
- Localize only after English data identifies a viable market. For the initial U.S./Canada launch,
  use English (U.S.) for both; add Canadian English localization only if storefront testing reveals a
  material difference.

### Chrome Web Store

- Search uses listing metadata; keep name, short description, and opening paragraph complete and
  accurate. Avoid keyword stuffing.
- Chrome says ranking also considers ratings, downloads versus uninstalls, visual quality, clear
  purpose, onboarding, and ease of use. The fastest organic win is therefore qualified acquisition +
  a flawless enable/first-result flow.
- Keep YouTube blocking accessible without credentials or payment. This also preserves eligibility
  for Featured-badge nomination, whose current criteria require core functionality to be accessible
  free of credentials/payment.
- Verify the publisher identity and keep a spotless policy record. Established/Featured badges are
  discovery and trust signals, though new publishers need time to qualify.
- Upload the five numbered images and two promo tiles in `screenshots/store-ready/chrome/`. Chrome
  accepts at most five screenshots; the small promo tile is required and the marquee tile is optional.
- Invite reviews after seven active days or a voluntary settings return, not at install.
- Track weekly: store impressions, listing visitors, installs, uninstalls, rating count/average, and
  scope-related reviews. A rising uninstall rate means the copy or onboarding is overpromising.

### Firefox Add-ons

- Use the same name and message system as Chrome so users recognize Still across stores.
- Complete every optional listing field, upload the single unannotated screenshot in
  `screenshots/store-ready/firefox/`, choose two accurate categories, provide a support link, and use
  a high-resolution icon. Mozilla recommends 1280x800 screenshots and avoiding explanatory text in
  the image itself; add the explanation in the screenshot-description field.
- State “Desktop Firefox only” near the beginning, not solely in technical compatibility metadata.
- Keep source submission reproducible and review notes concise; delayed approvals interrupt growth
  and trust even when marketing is strong.
- After approval, link the AMO page from the homepage and Chrome/Apple support copy. Cross-store links
  reinforce the one-product identity.

### Web and off-store organic acquisition

- The homepage title and description target “block Shorts,” “block Reels,” Safari, Chrome, and Firefox
  without turning the visible hero into a keyword list.
- Publish four focused help pages that answer high-intent queries and link to the relevant store:
  1. “How to block YouTube Shorts without blocking YouTube”
  2. “How to remove Instagram Reels in Safari”
  3. “A short-form video blocker that works across Safari, Chrome, and Firefox”
  4. “Why browser extensions cannot block native iPhone apps”
- Each page uses the same promise, free/Pro split, compatibility notice, and CTA. Do not invent a new
  campaign slogan per article.
- Submit the site to Google Search Console and Bing Webmaster Tools, add an XML sitemap, canonical
  URLs, and Open Graph image. Measure store-bound clicks with privacy-preserving query tags; do not add
  behavioral ad tracking that contradicts the product position.

## 9. Product conversion moments

### Free activation copy

> **YouTube Shorts are gone.**
> Open YouTube for what you came for. Still will keep the short-form feed out of the way.

### Pro upsell headline

> **Make every supported browser feel this quiet.**

### Pro upsell body

> Remove Instagram and Facebook Reels, block the TikTok website, and sync your settings across
> supported browsers and devices. $1.99 once. No subscription.

### Pro CTA

> Get Still Pro — $1.99 once

### Sign-in explanation

> Sign in with your email so your Still Pro purchase and settings can follow you to every supported
> surface.

### Pre-purchase scope disclosure

> On iPhone and iPad, Still works in Safari only. It does not block short-form video inside native
> apps.

Place this disclosure immediately above the purchase confirmation/CTA on every surface. A store
listing disclosure does not replace an in-product pre-purchase disclosure.

### Purchase success

> **Your quieter web is ready.**
> Still Pro is unlocked on every supported surface where you sign in with this email.

## 10. Review and referral prompts

Use a two-step prompt only after the product has delivered value.

**Soft prompt:**

> Is Still making your browser feel calmer?

- If yes: offer “Rate Still.”
- If no: offer “Tell us what went wrong,” opening support rather than a store review.

**Share copy:**

> I use Still to remove Shorts and Reels from my browser. YouTube Shorts are free to block, and Still
> Pro is $1.99 once across supported browsers: https://zackc-1.github.io/still-app/

Do not gate functionality, nag repeatedly, or reward ratings.

## 11. 30/60/90-day operating plan

### Before approval / day 0

- Upload the new copy and numeric screenshot sequence to every editable listing.
- Publish the homepage, support, and privacy changes.
- Add the same scope disclosure immediately above every Pro purchase CTA.
- Verify one purchase restores on Apple, Chrome, and Firefox using the same email.
- Replace temporary store search URLs with direct URLs.

### Days 1–30: establish signal

- Keep creative stable for two weeks to establish a baseline.
- Review store search terms, impressions, page views, installs, uninstalls, Pro purchases, refunds, and
  review themes weekly.
- Personally answer every support message and substantive review within two business days.
- Publish the first two high-intent help pages.
- Fix activation failures before expanding acquisition.

### Days 31–60: test conversion

- Apple: run one Product Page Optimization test on screenshot 01. Challenger headline:
  “YouTube without the pull.” Keep all other assets identical.
- Chrome/Firefox: change only the first screenshot if the same hypothesis wins on Apple; extension
  stores lack the same native experimental controls, so use clean four-week before/after windows.
- Test the in-product Pro headline, not price: control “Make every supported browser feel this quiet”
  versus “One purchase. A quieter web on every supported screen.”
- Publish the cross-platform and native-app limitation help pages.

### Days 61–90: compound organic reach

- Keep winners and retire losing variants.
- Request Chrome Featured-badge consideration once eligibility and quality criteria are satisfied.
- Choose the first localization from actual geography/search data, not intuition.
- Add a 20–30 second muted Apple app preview only if static screenshots have reached a stable baseline.
- Use review/support language to refine FAQ and listing copy without changing the central brand promise.

## 12. Research basis

- [Apple: Creating Your Product Page](https://developer.apple.com/app-store/product-page/) — metadata,
  keywords, screenshot order, ratings/reviews, localization, and product-page testing.
- [Apple: Product Page Optimization](https://developer.apple.com/app-store/product-page-optimization/)
  — controlled creative testing through App Store Connect.
- [Apple: Custom Product Pages](https://developer.apple.com/app-store/custom-product-pages/) —
  audience-specific pages and assets after the default page has a baseline.
- [Chrome: Web Store discovery](https://developer.chrome.com/docs/webstore/discovery) — search metadata,
  ratings, downloads/uninstalls, usability, visual quality, badges, and featuring.
- [Chrome: Web Store best practices](https://developer.chrome.com/docs/webstore/best-practices) —
  high-quality extension and listing guidance.
- [Mozilla: Create an appealing listing](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/)
  — complete Firefox listing and presentation guidance.
- [Harvard Business School: Know Your Customers’ “Jobs to Be Done”](https://www.hbs.edu/faculty/Pages/item.aspx?num=51553)
  — customer progress in context and the social/emotional dimensions of the job.
- [AppTweak: What is App Store Optimization?](https://www.apptweak.com/en/aso-blog/what-is-app-store-optimization-and-why-is-aso-important)
  — practitioner guidance on the interaction of visibility, creative conversion, ratings, and testing.

Research depth: thorough (official platform documentation plus practitioner and customer-progress
framework sources). Store algorithms are not fully disclosed; any keyword-volume or causal conversion
claim must be treated as a test hypothesis until Still's own store data confirms it.
