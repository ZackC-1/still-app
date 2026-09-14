# Still launch-growth research — July 14, 2026

This is the evidence-backed launch plan while Apple, Chrome, and Firefox reviews are pending. It
does not authorize a resubmission: changing pending store metadata or assets can restart review.
Use it after each listing becomes public, and measure each change against that store's own
impressions, listing visitors, installs, uninstalls, ratings, refunds, and Pro purchases.

## What the live market shows

- Exact-intent discovery is real. The leading Chrome competitor,
  [Youtube-shorts block](https://chromewebstore.google.com/detail/youtube-shorts-block/jiaopdjbehhjgokpphdfgmapkobbnmjp),
  presents the concrete outcome first (hide Shorts and open a Shorts URL in the normal player) and
  currently shows 300,000 users, about 1,000 ratings, and a 4.5 rating. Still already matches that
  free, immediately understandable use case.
- The multi-site category is crowded with broad “focus” promises. Examples such as
  [Hide Shorts, Reels & Stories](https://chromewebstore.google.com/detail/hide-shorts-reels-stories/jnbhalknaohaiodbcokhhnljkabffnpn)
  and [Focus](https://addons.mozilla.org/en-US/firefox/addon/focus-remove-shorts-reels/)
  enumerate many controls, including feeds and DMs. Still should not copy that scope: its sharper
  position is *keep the useful site; remove the short-form invitation*, with permissions limited to
  four named sites and no browsing-history analytics.
- Apple has direct, single-purpose Safari competitors at $1.99–$4.99, including
  [Shorts Blocker for YouTube](https://apps.apple.com/us/app/shorts-blocker-for-youtube/id6451330524)
  and [Block YT Shorts for Safari](https://apps.apple.com/us/app/block-yt-shorts-for-safari/id6754257092).
  Still's stronger entry point is not a cheaper paid utility: it is a free YouTube Shorts win,
  followed by a clear one-time $1.99 Pro expansion across supported devices.
- Search vocabulary consistently uses “block,” “hide,” “remove,” “Shorts,” and “Reels.” Keep those
  terms in store metadata and guide-page titles, while the visible brand voice remains “Open for
  what you came for.”

## Changes made in this pass

1. The native first-run flow now promises the free, immediate result—YouTube Shorts are gone—rather
   than claiming Reels and TikTok are already removed for a non-Pro user. It introduces Pro only as
   the optional next step.
2. Support now gives version-correct iOS Safari-extension instructions, says that YouTube is on by
   default, tells browser users to reload once, and names the Pro boundary in troubleshooting.
3. Homepage Chrome calls-to-action and structured-data download URL now use the canonical public
   Chrome Web Store slug, rather than relying on its redirect.

## Release-ready distribution moves

Do these only when the relevant listing is public.

1. Add direct App Store and AMO buttons to the homepage's compatibility section. Keep Chrome as the
   hero default only for desktop Chromium visitors; do not show an unavailable store button.
2. Publish the four high-intent articles in `launch-content-pack.md`, each linked to the correct
   live store. Add their final URLs to `docs/sitemap.xml` and link them from Support and the home
   page's footer or FAQ area.
3. Keep the first three store screenshots in outcome order: calm/useful web → free YouTube Shorts
   proof → Still Pro's multi-site, one-purchase value. The mobile native-app limitation needs its
   own screenshot, not fine print.
4. After a stable two-week baseline, test only one creative variable at a time. Start with the first
   screenshot headline on Apple. For Chrome and Firefox, use a clean before/after window; do not
   infer causation from a simultaneous listing rewrite.
5. Respond to substantive reviews within two business days. An “it does not work in the native
   app” response should acknowledge the Safari-only boundary, point to Support, and offer the
   appropriate refund route—not argue with the reviewer.

## Conversion plan without new product functionality

- **Activation is the first conversion mechanism.** The user must see the free YouTube result before
  any Pro ask. The revised onboarding and support path make that moment more likely.
- **Locked service rows are the right moment for the Pro explanation.** They already open the
  paywall/sign-in path instead of silently toggling. Keep the value statement concrete: Instagram
  and Facebook Reels, the TikTok website block, and settings sync—not generic “more focus.”
- **Use one-purchase portability as the premium differentiator.** Repeat “same email” and “every
  supported surface,” never “everywhere.” This is more defensible than feature-count comparison and
  addresses the most common paid-browser-tool concern: paying twice on a second device.
- **Ask for advocacy only after value.** The existing proposed soft prompt (“Is Still making your
  browser feel calmer?”) belongs after a verified success moment and a return visit, never on
  install, at purchase, or after an error. A negative answer should open Support; a positive answer
  can offer a store rating or a user-initiated share message. Do not reward ratings or shares.
- **Protect conversion by protecting trust.** Scope disclosure stays immediately above every purchase
  CTA. The explicit native-app limitation will lower mismatched installs and may improve paid
  conversion quality even if it reduces raw installs.

## Feature candidates to research after launch (not being built now)

| Candidate | Why it may help | Primary risk / validation needed |
|---|---|---|
| In-product “check YouTube” activation check | Closes the install → enabled → first-result gap and creates a reliable moment for a later review prompt. | Must work without collecting browsing history; test whether it improves retained activation rather than adding friction. |
| Browser-specific pin/open guidance | Makes the extension easier to find again in Chrome and Firefox, supporting returns and upgrades. | Browser UI varies; keep it opt-in and platform-specific. |
| A user-initiated post-success share sheet | Lets genuinely satisfied users share the free use case with friends. | No incentives, no prefilled claims that overpromise mobile-app blocking, and no repeated prompts. |
| Per-service upgrade education | Lets a user learn what a locked Instagram, Facebook, or TikTok row means before committing. | The current locked-row paywall may already be sufficient; compare completion and refund rates before adding UI. |
| More YouTube cleanup controls | Competitors advertise search/feed/notices cleanup beyond Shorts. | Risks diluting Still's “keep the useful parts” promise; only pursue if support and review evidence says Shorts surfaces remain a meaningful leak. |

## Success criteria

- Activation: installs that successfully enable the extension and reach the free YouTube result.
- Acquisition quality: installs, uninstall rate, scope-related support/reviews, and rating volume by
  store and country.
- Monetization: view of locked service / paywall, sign-in completion, checkout initiation, confirmed
  Pro purchase, restore success, refund rate, and paid-support themes.

Store dashboards and support tags are sufficient for the initial baseline. Do not add behavioral
analytics that conflicts with Still's privacy promise merely to make this measurement easier.
