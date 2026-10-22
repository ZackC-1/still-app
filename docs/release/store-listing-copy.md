# Still store listing copy

**Current: the [3.0 release listing](#30-release-listing-minimal-update-of-the-21-copy), a minimal
update of the 2.1 copy. Draft written October 22, 2026; owner-gated: nothing here goes into a store
portal until the owner approves it line by line.** Below it, the
[later listing experiment](#later-listing-experiment-not-for-the-30-submission) is a full V3 rewrite
kept for a separate test after release. The shipped 2.1 copy is kept at the end, collapsed. The 2.0
copy is in Git history.

V3 keeps the free core and adds Still Pro, an optional one-time purchase
([V3 record](history/v3/README.md), [go-live runbook](v3-go-live-runbook.md) Phases 5 and 6). Every
length below was counted with a script against the store’s limit (characters; Apple keywords in
bytes). Owner edits made directly in a portal are intentional; merge them rather than overwrite
them. Use [public contact addresses](public-contact-addresses.md). Never put review credentials,
codes or email addresses other than the public support addresses in this file: review access goes
only in each portal’s private fields.

Accuracy rules (3.0): Still removes YouTube Shorts and Instagram/Facebook Reels and blocks the TikTok
website for free on every supported surface, with no account; the free core never claims to hide
feeds, Stories, Explore or comments, and only Still Pro’s optional extras do, named as the product
names them; sign-in is optional and only adds free settings sync; Still Pro is optional, one-time,
and never gates the free outcome; no listing claims that a Chrome or Firefox purchase unlocks Safari;
on phones Still works in Safari on iPhone and iPad (say nothing about Android; never mobile Chrome,
mobile Firefox or native apps); never “everywhere”, “free forever” or “no tracking”; Still doesn’t
collect browsing history; usage data follows [ADR 0004](../adr/0004-first-party-usage-analytics.md).
No em dashes, no hype words.

## 3.0 release listing (minimal update of the 2.1 copy)

**This is the copy for the 3.0 submission.** Owner ruling, October 22, 2026: at release the listings
change only marginally, so the effect of a new listing can be tested later, separately from the
version. Everything in the [shipped 2.1 copy](#shipped-21-copy-reference) stays (name, subtitle,
summaries, promotional text, keywords, categories, screenshots) except the lines below. Each change
is shown as the 2.1 line and its 3.0 replacement, so it can be approved line by line. Owner answers
already applied: summaries unchanged, no keyword swap, no “twelve”, no price and no refund line in
the browser listings.

What changes, and only this:

- (a) every 2.1 sentence that 3.0 makes false (listed next);
- (b) one short optional Still Pro sentence per description, where accuracy needs it;
- (c) the required declarations (Chrome “Financial and payment information”, AMO “Requires
  payment”, the Firefox manifest’s data-collection list);
- (d) nothing anywhere claims that a Chrome or Firefox purchase unlocks Safari;
- (e) the Still Pro in-app purchase’s own name, description and review screenshot.

### Every 2.1 sentence that 3.0 makes false

| # | 2.1 sentence (where) | Why it is false in 3.0 | Fix |
|---|---|---|---|
| F1 | “Still removes Shorts and Reels and never claims to hide feeds, Stories, Explore or comments” (accuracy rules) | Still Pro hides Stories, Explore recommendations and comments | Rule rewritten in the intro: the free core never claims it; Still Pro’s extras do, by their in-product names |
| F2 | “• One switch per site. Turn any of them on or off whenever you want, from any device.” (Apple iPhone and Mac descriptions) | Still Pro adds more switches inside each site | A1 |
| F3 | “• One switch per site, right in your toolbar. Turn any of them on or off whenever you want.” (Chrome and Firefox descriptions) | Same | C1 |
| F4 | “No timers, no streaks, no screen-time stats, no wall of options. One switch per site.” (Chrome and Firefox descriptions) | Same; Still Pro adds options | C3 |
| F5 | “Still takes out the short videos and leaves the rest of each site as it is.” (all four descriptions) | Still Pro can hide comments, Stories, Explore and more | A2, C2 |
| F6 | “Blocking needs no account and no purchase.” (all four descriptions) | Read with Still Pro’s per-site extras, “blocking” no longer means only the free core | A3, C4 |
| F7 | 2.1 What’s New and the Chrome and Firefox release notes (“New in 2.1: a ‘Share usage data’ switch ...”) | Describes the 2.1 change; 3.0 needs its own notes | A4, C5, X3 |
| F8 | Apple review notes: “Still is free. No purchase or account is needed to test any blocking feature.” and “Purchase infrastructure remains in the project for historical entitlements, with paid features disabled. No in-app purchase is needed to use Still.” | 3.0 has Still Pro on | Replaced by the [3.0 App Review notes](#v3-apple-app-review-information) |
| F9 | Chrome single purpose: “Remove YouTube Shorts and Instagram/Facebook Reels, and block the TikTok website, so people can use those websites with fewer short-form video distractions.” | Narrower than what 3.0 does | C6 |
| F10 | Chrome “Data not collected: ... Financial ...” | Still keeps Still Pro purchase records | C8 |
| F11 | AMO reviewer notes: “All blocking and optional settings sync are free. No account or purchase is needed for blocking.” | Same as F6 | X4 |
| F12 | AMO caption for `firefox-05-switches`: “One switch per site, from Still’s button in Firefox’s toolbar.” | Same as F2 | X5 |
| F13 | Image headlines “One switch per site” in `iphone-03-switches`, `mac-05-app`, `chrome-05-switches` (and the Apple caption list item 4) | Same as F2, and they picture the 2.1 interface | Screenshot findings below; the images are kept by owner ruling |
| F14 | Support reply “Earlier Pro purchase: Update to Still 2.0 to use all blocking and optional settings sync for free. No purchase restore is needed.” (not a store field) | Verified earlier purchases map to Still Pro in 3.0 | [3.0 support replies](#30-support-replies); not part of any store upload |

Checked and still true in 3.0, so unchanged: the Apple name, subtitle and both promotional texts
(the closing “Free.” describes the free download and free core; Apple shows “In-App Purchases”
beside it), the keywords, both store summaries, “No timers, no streaks, no screen-time stats. Just
the blocking, where you want it, when you want it.”, “Still’s free extensions” (the extensions are
free to install), every “PRIVATE BY DESIGN” paragraph and every “WHERE IT WORKS” / “HOW IT WORKS”
paragraph.

### 3.0 Apple listing changes (iPhone, iPad and Mac)

Same four edits in the iPhone and Mac descriptions.

| # | 2.1 (old) | 3.0 (new) |
|---|---|---|
| A1 | • One switch per site. Turn any of them on or off whenever you want, from any device. | • A switch for each site. Turn any of them on or off whenever you want, from any device. |
| A2 | Still takes out the short videos and leaves the rest of each site as it is. | Still takes out the short videos and leaves the rest of each site as it is, unless you choose to hide more. |
| A3 | Blocking needs no account and no purchase. Sign-in is optional and only adds sync. | Removing Shorts and Reels and blocking the TikTok website need no account and no purchase. Sign-in is optional and only adds sync. Still Pro, an optional one-time purchase, hides more on YouTube, Instagram and Facebook, such as comments and Stories. |
| A4 | What’s New: New in 2.1: a “Share usage data” switch. Still now shares how the app is used, such as which settings are turned on and whether setup finished, to help us improve it. It never includes the pages or videos you visit. You can turn it off anytime in Settings. | What’s New: New in 3.0: Still Pro, an optional one-time purchase that hides more on YouTube, Instagram and Facebook, such as comments and Stories. A single Reel someone sends you now plays. Removing Shorts and Reels, blocking the TikTok website and settings sync stay free. |
| A5 | Version 2.1.0 | Version 3.0 (owner confirms in runbook step 0.3) |

“Comments and Stories” are both offered on iPhone and iPad (YouTube Comments, Instagram Stories and
Highlights, Facebook Stories), so the sentence is true on every Apple device.

| Field | Value | Length |
|---|---|---|
| Name, subtitle | Unchanged | 29/30, 28/30 |
| Promotional Text (iPhone and iPad) | Unchanged | 164/170 |
| Promotional Text (Mac) | Unchanged | 164/170 |
| Keywords | Unchanged | 99/100 bytes |
| What’s New (both) | A4 | 261/4000 |
| Description (iPhone and iPad) | 2.1 text with A1 to A3 | 2179/4000 |
| Description (Mac) | 2.1 text with A1 to A3 | 2247/4000 |

<details>
<summary>Full 3.0 iPhone and iPad description, ready to paste</summary>

```
Still removes Shorts and Reels from the websites you use, so a quick visit stays a quick visit. Change your settings on any device, and the latest version follows you between your phone and your computer.

WHAT STILL DOES
• Removes YouTube Shorts. A Shorts link opens as a normal video.
• Removes Instagram Reels and Facebook Reels.
• Blocks the TikTok website.
• A switch for each site. Turn any of them on or off whenever you want, from any device.

WHAT YOU KEEP
Regular YouTube videos, search and subscriptions. Instagram and Facebook posts, friends and messages. Still takes out the short videos and leaves the rest of each site as it is, unless you choose to hide more.

YOUR SETTINGS FOLLOW YOU
Choose what’s blocked in the Still app on your iPhone or your Mac, and change it whenever you like. Sign in free with your email on each device, and your latest settings reach Safari on your iPhone, iPad and Mac, and the Still extensions for Chrome and Firefox on your computer. Change a setting in one place and the others follow.

NO LOGGING IN TO ANOTHER APP
Still works in the Safari, Chrome or Firefox you already use, signed in as you. There’s no separate browser to log in to.

SIMPLE ON PURPOSE
No timers, no streaks, no screen-time stats. Just the blocking, where you want it, when you want it.

FREE
Removing Shorts and Reels and blocking the TikTok website need no account and no purchase. Sign-in is optional and only adds sync. Still Pro, an optional one-time purchase, hides more on YouTube, Instagram and Facebook, such as comments and Stories.

HOW IT WORKS
Still works on websites. On iPhone and iPad it works in Safari; on your computer it works in Safari, Chrome and Firefox. It can’t change the YouTube, Instagram, Facebook or TikTok apps, so many people delete those apps and use the websites with Still instead.

PRIVATE BY DESIGN
Blocking runs on your device. Still doesn’t collect your browsing history or show ads, and it only has access to YouTube, Instagram, Facebook and TikTok. Still shares usage data to help improve the app; you can turn it off in Settings.

Setup and support: https://stillapp.fit/support/
Privacy: https://stillapp.fit/privacy/
```

</details>

<details>
<summary>Full 3.0 Mac description, ready to paste</summary>

```
Still removes Shorts and Reels from Safari, Chrome and Firefox on your Mac, so a quick visit stays a quick visit. Control them all from the Still app on your Mac (Chrome and Firefox use Still’s free extensions), and your latest settings follow you to your iPhone and iPad.

WHAT STILL DOES
• Removes YouTube Shorts. A Shorts link opens as a normal video.
• Removes Instagram Reels and Facebook Reels.
• Blocks the TikTok website.
• A switch for each site. Turn any of them on or off whenever you want, from any device.

WHAT YOU KEEP
Regular YouTube videos, search and subscriptions. Instagram and Facebook posts, friends and messages. Still takes out the short videos and leaves the rest of each site as it is, unless you choose to hide more.

YOUR SETTINGS FOLLOW YOU
Choose what’s blocked in the Still app on your iPhone or your Mac, and change it whenever you like. Sign in free with your email on each device, and your latest settings reach Safari on your iPhone, iPad and Mac, and the Still extensions for Chrome and Firefox on your computer. Change a setting in one place and the others follow.

NO LOGGING IN TO ANOTHER APP
Still works in the Safari, Chrome or Firefox you already use, signed in as you. There’s no separate browser to log in to.

SIMPLE ON PURPOSE
No timers, no streaks, no screen-time stats. Just the blocking, where you want it, when you want it.

FREE
Removing Shorts and Reels and blocking the TikTok website need no account and no purchase. Sign-in is optional and only adds sync. Still Pro, an optional one-time purchase, hides more on YouTube, Instagram and Facebook, such as comments and Stories.

HOW IT WORKS
Still works on websites. On iPhone and iPad it works in Safari; on your computer it works in Safari, Chrome and Firefox. It can’t change the YouTube, Instagram, Facebook or TikTok apps, so many people delete those apps and use the websites with Still instead.

PRIVATE BY DESIGN
Blocking runs on your device. Still doesn’t collect your browsing history or show ads, and it only has access to YouTube, Instagram, Facebook and TikTok. Still shares usage data to help improve the app; you can turn it off in Settings.

Setup and support: https://stillapp.fit/support/
Privacy: https://stillapp.fit/privacy/
```

</details>

### 3.0 Still Pro in-app purchase

New in 3.0, so there is no 2.1 line. App Store Connect, **Monetization**, **In-App Purchases**,
**Still Pro** (`still_pro_v3`), **App Store Localization**, English (U.S.). Limits: display name 30,
description 45
([Apple reference](https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/in-app-purchase-information/)).

| Field | Value | Length |
|---|---|---|
| Display Name | Still Pro | 9/30 |
| Description | Fewer distractions. One-time purchase. | 38/45 |
| Review Notes (IAP) | One-time, non-consumable purchase. Open Still and tap Get Still Pro, then complete the sandbox purchase on the review device. Sign-in is offered first and can be skipped with “Buy without an account”. Restore purchase works without signing in. | 243/4000 |
| Review Screenshot | A full-screen capture of the Still Pro purchase screen with Get Still Pro, from the 3.0 iPhone build (1320×2868 is accepted). Review only, never shown to customers. Missing today (runbook 5.2d, V43). | |

The description states no number of extras and no price: one product serves iPhone, iPad (nine
extras) and Mac (twelve), and Apple shows the price.

### 3.0 Apple App Review Information and App Privacy

- **App Review notes:** use the [V3 App Review notes](#v3-apple-app-review-information) below as
  written (1966/4000; placeholders `<review email>` and `<review code>` only in this file; real values
  only in the portal’s User name and Password fields). They replace every 2.1 paragraph (F8).
- **App Privacy:** use the [V3 App Privacy label](#v3-apple-app-privacy-label) below: Purchase
  History with App Functionality (Still Pro rights) and Analytics (consented purchase events),
  Product Interaction kept for analytics. Confirm on screen (runbook 5.5, V47).

### 3.0 Chrome Web Store changes

| # | 2.1 (old) | 3.0 (new) |
|---|---|---|
| C1 | • One switch per site, right in your toolbar. Turn any of them on or off whenever you want. | • A switch for each site, right in your toolbar. Turn any of them on or off whenever you want. |
| C2 | Still takes out the short videos and leaves the rest of each site as it is. | Still takes out the short videos and leaves the rest of each site as it is, unless you choose to hide more. |
| C3 | No timers, no streaks, no screen-time stats, no wall of options. One switch per site. | No timers, no streaks, no screen-time stats. A switch for each site. |
| C4 | Blocking needs no account and no purchase. Sign-in is optional and only adds sync. | Removing Shorts and Reels and blocking the TikTok website need no account and no purchase. Sign-in is optional and only adds sync. Still Pro, an optional one-time purchase, hides more on YouTube, Instagram and Facebook, such as comments and Stories. |
| C5 | Release notes: New in 2.1: a “Share usage data” switch in settings. Still can share how the extension is used, such as which switches are on and whether setup finished, to help us improve it. It never includes the pages or videos you visit. You can turn it off anytime. | Release notes: New in 3.0: Still Pro, an optional one-time purchase that hides more on YouTube, Instagram and Facebook, such as comments and Stories. A single Reel someone sends you now plays. Removing Shorts and Reels, blocking the TikTok website and settings sync stay free. |
| C6 | Single purpose: Remove YouTube Shorts and Instagram/Facebook Reels, and block the TikTok website, so people can use those websites with fewer short-form video distractions. | Single purpose: Reduce distractions on YouTube, Instagram, Facebook and TikTok: remove YouTube Shorts and Instagram/Facebook Reels, block the TikTok website, and, with optional Still Pro, hide other parts of YouTube, Instagram and Facebook that the person switches on. |
| C7 | `storage`: Saves Still’s settings and the signed-in session on the device. | `storage`: Saves Still’s settings, the signed-in session and the Still Pro status on the device. |
| C8 | Data collected: Personally identifiable information (email, only for optional sign-in); Authentication information (sign-in code and session); User activity (product interactions such as switch changes and setup steps). | Same three, plus **Financial and payment information**, ticked. Justification: “Still keeps a record of each Still Pro purchase (purchase status and the payment provider’s transaction reference) to unlock the extras and handle refunds; card details are entered on the payment provider’s checkout page and never reach the extension.” |
| C9 | Data not collected: Health, Financial, Personal communications, Location, Web history, Website content. | Data not collected: Health, Personal communications, Location, Web history, Website content. |
| C10 | Host permissions: Applies blocking only on YouTube, Instagram, Facebook and TikTok. No other sites. | Host permissions: Applies Still’s switches only on YouTube, Instagram, Facebook and TikTok: removing Shorts and Reels, blocking the TikTok website and any Still Pro extras the person turns on. No other sites. |
| C11 | Test instructions (2.1 had none in this file) | The [V3 Chrome test instructions](#v3-chrome-web-store) below, as written (no fixed code; the web checkout opens on a RevenueCat page; no test card needed). |

Unchanged: name (44/45), summary (130/132), category, `alarms`, `declarativeNetRequestWithHostAccess`,
remote code, certifications, privacy URL, screenshots and promo tiles.

| Field | Length |
|---|---|
| Name | 44/45 (unchanged) |
| Summary | 130/132 (unchanged) |
| Description | 2204/16000 |
| Release notes | 261 |

<details>
<summary>Full 3.0 Chrome description, ready to paste</summary>

```
Still removes Shorts and Reels from the websites you use, so a quick visit stays a quick visit. Change your settings on any device, and the latest version follows you across your browsers.

WHAT STILL DOES
• Removes YouTube Shorts from the home page, search, subscriptions and the sidebar. A Shorts link opens as a normal video.
• Removes Instagram Reels and Facebook Reels.
• Blocks the TikTok website.
• A switch for each site, right in your toolbar. Turn any of them on or off whenever you want.

WHAT YOU KEEP
Regular YouTube videos, search and subscriptions. Instagram and Facebook posts, friends and messages. Still takes out the short videos and leaves the rest of each site as it is, unless you choose to hide more.

YOUR SETTINGS FOLLOW YOU
Sign in free with your email, and your settings sync between Chrome and Firefox on your computer, Safari on your Mac and Safari on your iPhone and iPad through the Still app. Change it here, or in the Still app on your iPhone or Mac, and your other browsers follow. Install Still on each browser or device you use.

NO LOGGING IN TO ANOTHER APP
Still works in the Safari, Chrome or Firefox you already use, signed in as you. There’s no separate browser to log in to.

SIMPLE ON PURPOSE
No timers, no streaks, no screen-time stats. A switch for each site.

FREE
Removing Shorts and Reels and blocking the TikTok website need no account and no purchase. Sign-in is optional and only adds sync. Still Pro, an optional one-time purchase, hides more on YouTube, Instagram and Facebook, such as comments and Stories.

WHERE IT WORKS
This extension works in Chrome on desktop. Still is also available for Firefox, and for Safari on iPhone, iPad and Mac. On phones, Still works in Safari on iPhone and iPad. It doesn’t work in mobile Chrome or Firefox, or inside the YouTube, Instagram, Facebook or TikTok apps.

PRIVATE BY DESIGN
Blocking runs on your device. Still doesn’t collect your browsing history or show ads, and it only has access to YouTube, Instagram, Facebook and TikTok. Still shares usage data to help improve the extension; you can turn it off in settings.

Setup and support: https://stillapp.fit/support/
Privacy: https://stillapp.fit/privacy/
```

</details>

### 3.0 Firefox Add-ons changes

C1 to C4 apply to the Firefox description as well (the same sentences). Firefox-only changes:

| # | 2.1 (old) | 3.0 (new) |
|---|---|---|
| X1 | Requires payment: No | Requires payment: No (unticked). Every free feature works without paying; the description names the optional purchase. |
| X2 | Summary (from the manifest) | Unchanged, 219/250. The store build uses `FIREFOX_2X_DESCRIPTION`, which says nothing about Android. |
| X3 | Release notes: New in 2.1: a “Share usage data” switch in settings. ... On Firefox it stays off unless you allow it. | Release notes: the C5 text. |
| X4 | Notes to reviewer: All blocking and optional settings sync are free. No account or purchase is needed for blocking. | Notes to reviewer: Removing Shorts and Reels, blocking the TikTok website and optional settings sync are free. No account or purchase is needed for them. |
| X4b | Notes to reviewer: New in 2.1: optional usage analytics declared as the optional “technicalAndInteraction” data collection permission. | Notes to reviewer: Usage analytics is declared as the optional “technicalAndInteraction” data collection permission. Then add the Still Pro paragraph from the [V3 AMO reviewer notes](#v3-firefox-add-ons) (“Still Pro is optional. To see its purchase flow ...”; no fixed code). |
| X5 | Caption `firefox-05-switches`: One switch per site, from Still’s button in Firefox’s toolbar. | Caption `firefox-05-switches`: A switch for each site, from Still’s button in Firefox’s toolbar. |
| X6 | Platform: desktop | On the upload’s platform step, untick Firefox for Android (runbook 6.5). |

The description’s privacy paragraph (“You can choose to share usage data to help improve Still; it
stays off unless you allow it.”) already matches the optional `technicalAndInteraction` permission,
so it is unchanged.

| Field | Length |
|---|---|
| Name | 44/45 (unchanged) |
| Summary | 219/250 (unchanged) |
| Description | 2208/15000 |
| Notes to reviewer (with X4, X4b and the Still Pro paragraph) | 1187 |

<details>
<summary>Full 3.0 Firefox description, ready to paste</summary>

```
Still removes Shorts and Reels from the websites you use, so a quick visit stays a quick visit. Change your settings on any device, and the latest version follows you across your browsers.

WHAT STILL DOES
• Removes YouTube Shorts from the home page, search, subscriptions and the sidebar. A Shorts link opens as a normal video.
• Removes Instagram Reels and Facebook Reels.
• Blocks the TikTok website.
• A switch for each site, right in your toolbar. Turn any of them on or off whenever you want.

WHAT YOU KEEP
Regular YouTube videos, search and subscriptions. Instagram and Facebook posts, friends and messages. Still takes out the short videos and leaves the rest of each site as it is, unless you choose to hide more.

YOUR SETTINGS FOLLOW YOU
Sign in free with your email, and your settings sync between Chrome and Firefox on your computer, Safari on your Mac and Safari on your iPhone and iPad through the Still app. Change it here, or in the Still app on your iPhone or Mac, and your other browsers follow. Install Still on each browser or device you use.

NO LOGGING IN TO ANOTHER APP
Still works in the Safari, Chrome or Firefox you already use, signed in as you. There’s no separate browser to log in to.

SIMPLE ON PURPOSE
No timers, no streaks, no screen-time stats. A switch for each site.

FREE
Removing Shorts and Reels and blocking the TikTok website need no account and no purchase. Sign-in is optional and only adds sync. Still Pro, an optional one-time purchase, hides more on YouTube, Instagram and Facebook, such as comments and Stories.

WHERE IT WORKS
This extension works in Firefox on desktop. Still is also available for Chrome, and for Safari on iPhone, iPad and Mac. On phones, Still works in Safari on iPhone and iPad. It doesn’t work in mobile Chrome or Firefox, or inside the YouTube, Instagram, Facebook or TikTok apps.

PRIVATE BY DESIGN
Blocking runs on your device. Still doesn’t collect your browsing history or show ads, and it only has access to YouTube, Instagram, Facebook and TikTok. You can choose to share usage data to help improve Still; it stays off unless you allow it.

Setup and support: https://stillapp.fit/support/
Privacy: https://stillapp.fit/privacy/
```

</details>

### Firefox manifest declarations before the AMO upload

Mozilla’s rules ([built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)):
“data transmission refers to any data collected, used, transferred, shared, or handled outside the
add-on or the local browser”, and every transmitted type must be listed in
`browser_specific_settings.gecko.data_collection_permissions`. The relevant types:

| Mozilla type | Mozilla’s examples | Still 3.0 in Firefox | Declared today (`packages/ext-chromium/wxt.config.ts`) |
|---|---|---|---|
| `authenticationInfo` | “passwords, usernames, ... registration information for extensions that offer account-based services” | The emailed sign-in code and session | Yes, required |
| `personallyIdentifyingInfo` | “contact information such as name and address, email, and phone number” | The email address sent to sign in | No |
| `financialAndPaymentInfo` | “credit card numbers, transactions, credit ratings, financial statements, or payment history” | Starting a Still Pro checkout for the account and reading back its purchase status (card details stay on the payment provider’s page) | No |
| `technicalAndInteraction` | “extension usage and settings data” | Usage analytics (ADR 0004) | Yes, optional (Mozilla allows it only as optional) |

**What the manifest must declare before the AMO upload:**

```
data_collection_permissions: {
  required: ["authenticationInfo", "personallyIdentifyingInfo", "financialAndPaymentInfo"],
  optional: ["technicalAndInteraction"],
}
```

- **Email address:** Mozilla names “email” under `personallyIdentifyingInfo`. One could argue the
  sign-in email is a username under `authenticationInfo`, but declaring it removes the doubt at no
  cost to the person (Chrome’s form already lists the email as personally identifiable).
- **Purchase status:** a Still Pro purchase record is a transaction handled outside the add-on, so
  `financialAndPaymentInfo` applies once Still Pro can be bought in Firefox.
- **Required, not optional:** optional types other than `technicalAndInteraction` are not shown at
  install and need a `permissions.request()` call inside the sign-in and Get Still Pro taps, which is
  a larger code change. Required matches how `authenticationInfo` is declared today. Firefox shows the
  added required types to existing users when they update.
- **This is a code change**, not a portal edit: `wxt.config.ts`, its test
  (`packages/ext-chromium/lib/__tests__/firefox-manifest.test.ts`), `tests/firefox/qa-first-run.spec.ts`
  and the manifest row in [03-firefox-amo.md](03-firefox-amo.md). It must land in the reviewed
  release build before the Firefox package is made (runbook 1.x and 6.4), and the privacy policy
  (runbook 7.1) must describe the same data. Owner decision; this PR changes no code.

### Screenshots: kept for 3.0, with what they no longer match

Owner ruling: the 2.1 screenshots stay for the 3.0 submission. These pictures show something 3.0
makes false or no longer shows; recapturing them belongs to the later experiment. Compared against
the 3.0 screens in [the ISS-0073 captures](history/v3/screenshots/iss0073/) and the current V3 source.

| File | What differs in 3.0 |
|---|---|
| `iphone/iphone-03-switches` | Headline “One switch per site.” (F13). Pictures the 2.1 app: “Still is on” hero, rows “YouTube Shorts / Shorts are gone.” in the order YouTube, Instagram, TikTok, Facebook, “How to set up Still” and the sync card “Sign in to keep your settings the same across your devices.” with “Sign in to sync”. 3.0 shows “Still is active”, rows “Instagram Blocker”, “Facebook Blocker”, “YouTube Blocker”, “TikTok Blocker” with expanders, a “Sign in” sync card, and the Still Pro card. |
| `iphone/iphone-06-safari-menu` | Safari menu shows the 2.1 popup (“Still is on”, the four 2.1 rows, “Settings are saved on this device.”). 3.0 popup uses the “Still is active” layout and Blocker rows. |
| `iphone/iphone-07-setup` | Setup screen subtitle reads “Enable the Still extension in Safari, then choose the websites where you want short-form video removed.” 3.0 reads “Enable the Still extension to use in Safari.”; recheck the status pill and the footer line on the 3.0 build. |
| `iphone/iphone-05-tiktok` | Shows 2.1’s “This site is blocked.” placeholder; 3.0 has its own TikTok page headed “TikTok stays closed.” (`TikTokBlocked.svelte`). Confirm on the 3.0 Safari build. |
| `ipad/ipad-01-safari-popup` | Safari toolbar popup is the 2.1 layout (as `iphone-06`). |
| `ipad/ipad-02-switches` | 2.1 app layout (as `iphone-03`). |
| `ipad/ipad-03-setup` | 2.1 setup subtitle (as `iphone-07`). |
| `mac/mac-05-app` | Headline “One switch per site.” (F13); 2.1 Mac app layout (“Still is on”, 2.1 rows, “How to set up Still”). |
| `mac/mac-06-chrome` | Chrome popup in the 2.1 layout. |
| `mac/mac-04-tiktok` | 2.1 “This site is blocked.” placeholder (as `iphone-05`). |
| `chrome/chrome-05-switches` | Headline “One switch per site, right in Chrome.” (F13); popup in the 2.1 layout (“Still is on”, “YouTube Shorts / Shorts are gone.”, sync “Sign in to keep your settings the same across your devices.”). |
| `chrome/chrome-04-tiktok` | 2.1 “This site is blocked.” placeholder; 3.0 shows “TikTok stays closed.” |
| `firefox/firefox-05-switches` | Same as `chrome-05-switches`, in Firefox; its AMO caption is fixed by X5, the image is not. |
| `firefox/firefox-04-tiktok` | Same as `chrome-04-tiktok`. |

Still accurate: the YouTube, Instagram and Facebook before-and-after frames on every store (they
show the sites, not Still’s interface; the free removal is unchanged), the Chrome promo tiles and
the Instagram feed posts. The 2.0 archive under `screenshots/archive/` is history, not an upload
candidate. Keeping pictures of an older interface risks Apple’s screenshot rule (they should show
the app in use) and Chrome’s listing-accuracy review; the owner may want to recapture at least the
four “switches” images before submission.

### 3.0 support replies

These replace the 2.1 “Customer support responses” (they are not store fields). The native-app and
privacy replies are unchanged; the earlier-purchase reply is new for 3.0 (F14).

Native-app question:

> On iPhone and iPad, Still works on websites opened in Safari. It cannot change the native YouTube, Instagram, Facebook or TikTok apps. Setup help: https://stillapp.fit/setup/

Earlier purchase (3.0):

> Thanks for buying Still Pro early. In Still 3.0, removing YouTube Shorts and Instagram and Facebook Reels, blocking the TikTok website and settings sync are all free, with no purchase or account needed.
>
> A paid Still Pro purchase from before 3.0 carries over to the new Still Pro extras when it is linked to your Still account, which it is if you were signed in to Still when you bought it. Sign in with that same email address and the extras appear in Still’s settings, switched off until you turn them on, and you don’t need to buy Still Pro again.
>
> If you don’t see them, choose Restore purchase while signed in: in the Still app on iPhone or Mac, or in Still’s settings in Chrome or Firefox. If Still still doesn’t find your purchase, email support@stillapp.fit from the address you used, with the date you bought it (for an App Store purchase, it’s on your Apple receipt), and we’ll look into it.
>
> Apple handles refunds for App Store purchases.

Privacy or data request:

> Email privacy@stillapp.fit for help with your Still account data.

**Facts behind the earlier-purchase reply (for the owner, read from code on 22 October 2026).** A
verified paid 2.x purchase (`still_sync` on Apple, or `still_sync_web` from RevenueCat’s web billing)
gets the full V3 Still Pro extras, not the old benefits, but only through the Still account.
On a signed-in reconcile, RevenueCat’s purchase list for the account is read and each mapped
`still_sync` purchase becomes a right whose benefit stays `still_sync`
(`supabase/functions/_shared/revenuecat-access.ts:60`, `:174`, `:177`). Only owned, directly
purchased, unrefunded purchases with positive USD revenue count, so the 2.0 era’s $0 acquisitions
grant nothing (`revenuecat-access.ts:195`). The ledger accepts `still_sync` rights
(`supabase/migrations/0020_apple_scoped_access.sql:192`, `:237`), and the reconcile signs every
observed right (`supabase/functions/reconcile-entitlement/handler.ts:110`, `:141`) as product
`still-pro-v3` with `STILL_PRO_V3_BENEFITS` (`supabase/functions/_shared/access-issuer.ts:96`;
`packages/shared-types/src/access.ts:11`). That matches the V3 rule “verified legacy payments map to
frozen Pro” (`docs/release/history/v3/README.md:25`). Restore finds it when signed in: the Apple
app checks the account first (`packages/core/src/ui/v3/apple-pro-host.ts:415`) and Chrome and
Firefox send Restore through sign-in (`packages/core/src/ui/v3/PurchaseView.svelte:105`). Four limits:
(1) **an Apple purchase never linked to an account is not recognised in 3.0.** The Apple verifiers
accept only `still_pro_v3` (`supabase/functions/_shared/apple-access.ts:35`, `:43`), the
historical product’s local grant is nil (`apps/apple/StillKit/Sources/StillKit/ApplePurchaseCatalog.swift:38`),
and V3 builds use the explicit link mode (`packages/app-webview/src/main.ts:311`), which skips the
2.x attach-on-sign-in (`packages/core/src/sync/apple-session.ts:279`) and never re-keys the purchase
SDK on sign-in (`apps/apple/Still/Shared (App)/Purchases/PurchaseManager.swift:443`). Restore does
read the historical receipt (`PurchaseManager.swift:522`), but local verification
(`apple-pro-host.ts:527`) cannot grant it, so the app shows the purchase as still being checked.
Support has no tool to grant these by hand: clients accept an `owner_attested_legacy_paid` proof
(`packages/core/src/entitlement/access-proof.ts:17`), but nothing on the server issues one. This
needs an owner decision. (2) The production `ACCESS_PROVIDER_PRODUCTS_JSON` must keep the
historical `still_sync` and `still_sync_web` mappings (production activation plan, step 2); without
them nobody’s earlier purchase is found. (3) Deleting a Still account deactivates its RevenueCat
rights (`supabase/migrations/0022_account_deletion_keeps_payment_records.sql`, header item 2), so a
buyer who deleted their account cannot recover the purchase with a new account. (4) The 2.x
`Restore purchase` rule in [04-revenuecat.md](04-revenuecat.md) and
[ADR 0003](../adr/0003-entitlement-authority-receipt-and-server.md) describes the retired
`still_sync = true` entitlement flag, not 3.0’s signed access rights. The reply promises none of
these: it says the purchase carries over “when it is linked to your Still account” and points
everyone else to support.

## Later listing experiment (not for the 3.0 submission)

A full V3 rewrite, kept for a listing test after release, separately from the version (owner
ruling, October 22, 2026). Do not paste it for the 3.0 submission. The 3.0 section above reuses
three parts of it as written: the App Review notes, the App Privacy label and the browser reviewer
notes. Owner answers so far: the summaries stay, no keyword swap, no “twelve” in the 3.0 listing;
the price and refund lines belong only to this experiment.

### V3 Still Pro extras (source of truth for every listing)

From `packages/shared-types/src/feature-registry.ts` (row names) and
`packages/core/src/ui/v3/presentation.ts` (`PRO_VALUE_PHRASES`, the “what it hides” wording the
listings use). Every extra starts off on a fresh install.

| Site | Extra (in-product row name) | Listing phrase | iPhone and iPad Safari |
|---|---|---|---|
| YouTube | Related videos | Related videos | Yes |
| YouTube | End-of-video suggestions | end-of-video suggestions | No (computer layout only) |
| YouTube | Autoplay prevention | autoplay prevention | Yes |
| YouTube | Comments | comments | Yes |
| YouTube | Live chat | live chat | No (computer layout only) |
| Instagram | Explore recommendations | Explore recommendations | Yes |
| Instagram | Stories and Highlights | Stories and Highlights | Yes |
| Instagram | Suggested accounts | suggested accounts | Yes |
| Instagram | Threads links | Threads links | Yes |
| Facebook | Facebook Stories | Stories | Yes |
| Facebook | Video tab | the Video tab | Yes |
| Facebook | Desktop sidebar ads | desktop sidebar ads | No (computer layout only) |

All twelve work in Chrome, Firefox and Safari on Mac. iPhone and iPad offer nine
(`DESKTOP_LAYOUT_ONLY_PRO` in `packages/core/src/entitlement/access-policy.ts`), so the iPhone
listing and the shared in-app purchase never promise “twelve” on a phone.

### V3 Apple App Information

Shared by iPhone, iPad and Mac. Unchanged from 2.1: the name and subtitle stay true for V3 and keep
their search history.

| Box | Value | Length |
|---|---|---|
| Name | Still: Reels & Shorts Blocker | 29/30 |
| Subtitle | Block Short Videos in Safari | 28/30 |
| Primary category | Productivity (unchanged) | |
| Secondary category | Utilities (unchanged) | |
| Privacy Policy URL | https://stillapp.fit/privacy/ | |

### V3 Apple iPhone and iPad version 3.0

| Box | Value | Length |
|---|---|---|
| Promotional Text | Shorts and Reels, gone from the websites you use in Safari, for free. New: Still Pro, a one-time purchase that hides more, like comments, Stories and Explore. | 158/170 |
| Keywords | `hide,stop,scroll,focus,social,media,screen,time,detox,doomscroll,brainrot,extension,form,comments` | 97/100 bytes |
| Support URL | https://stillapp.fit/support/ | |
| Marketing URL | https://stillapp.fit/ | |
| Version | 3.0 (owner confirms in runbook step 0.3) | |
| Copyright | © 2026 Cadmus Labs (no leading space) | |

Keywords change from 2.1: “comments” added for the Still Pro extras; “remove” and “web” dropped to
make room (Apple already indexes “Blocker”, “Block”, “Short”, “Videos” and “Safari” from the name
and subtitle, and the in-app purchase name “Still Pro”).

**What’s New** (457/4000; same text on Mac):

```
New in 3.0:
• Still Pro, an optional one-time purchase. It adds switches that hide more on YouTube, Instagram and Facebook, such as comments, Stories and Explore recommendations. Each extra starts off.
• A single Reel someone sends you now plays. Still stops the Reels feed after it.
• On Instagram, a profile’s Reels tab is hidden too.
Removing Shorts and Reels, blocking the TikTok website and settings sync stay free, and blocking still needs no account.
```

**Description** (2730/4000):

```
Still removes Shorts and Reels from the websites you use, so a quick visit stays a quick visit. It works in Safari on iPhone and iPad, and your settings can follow you to your Mac and to Chrome and Firefox on your computer.

FREE, NO ACCOUNT NEEDED
• Removes YouTube Shorts. A Shorts link opens as a normal video.
• Removes Instagram Reels and Facebook Reels. A single Reel someone sends you still plays, and the Reels feed stops there.
• Blocks the TikTok website.
• One switch per site. Turn any of them on or off whenever you want.

WHAT YOU KEEP
Regular YouTube videos, search and subscriptions. Instagram and Facebook posts, friends and messages. Still takes out the short videos and leaves the rest of each site as it is.

YOUR SETTINGS FOLLOW YOU
Sign-in is optional and free. Sign in with your email on each device, and your settings stay the same in Safari on your iPhone, iPad and Mac, and in the Still extensions for Chrome and Firefox. Change a setting in one place and the others follow.

STILL PRO, IF YOU WANT MORE
Still Pro is an optional one-time purchase, not a subscription. It adds extra switches. Each one starts off, so you turn on only the ones you want:
• YouTube: Related videos, end-of-video suggestions, comments and live chat, plus autoplay prevention.
• Instagram: Explore recommendations, Stories and Highlights, suggested accounts and Threads links.
• Facebook: Stories, the Video tab and desktop sidebar ads.
On iPhone and iPad, Still Pro offers nine of these. End-of-video suggestions, live chat and desktop sidebar ads only appear in each site’s computer layout, so they work in Safari on Mac and in Chrome and Firefox. Sign in with a free Still account and one purchase also works in Still for Chrome and Firefox on your computer. Still Pro never changes what’s free: removing Shorts and Reels, blocking the TikTok website and settings sync need no purchase.

SIMPLE ON PURPOSE
No timers, no streaks, no screen-time stats. Just the switches, where you want them, when you want them.

HOW IT WORKS
Still works on websites. On iPhone and iPad it works in Safari; on your computer it works in Safari, Chrome and Firefox. It can’t change the YouTube, Instagram, Facebook or TikTok apps, so many people delete those apps and use the websites with Still instead.

PRIVATE BY DESIGN
Blocking runs on your device. Still doesn’t collect your browsing history or show ads, and it only has access to YouTube, Instagram, Facebook and TikTok. Still shares usage data, such as which switches are on, to help improve the app. It never includes the websites, pages or videos you visit, and you can turn it off in Settings.

Setup and support: https://stillapp.fit/support/
Privacy: https://stillapp.fit/privacy/
```

### V3 Apple Mac version 3.0

| Box | Value | Length |
|---|---|---|
| Promotional Text | Shorts and Reels, gone from Safari, Chrome and Firefox on your Mac, for free. New: Still Pro, a one-time purchase that hides more, like comments, Stories and Explore. | 166/170 |
| Keywords | Same as iPhone and iPad | 97/100 bytes |
| Support URL, Marketing URL, Version, Copyright | Same as iPhone and iPad | |
| What’s New | Same as iPhone and iPad | 457/4000 |

**Description** (2748/4000):

```
Still removes Shorts and Reels from Safari, Chrome and Firefox on your Mac, so a quick visit stays a quick visit. Control Safari from the Still app on your Mac (Chrome and Firefox use Still’s free extensions), and your settings can follow you to your iPhone and iPad.

FREE, NO ACCOUNT NEEDED
• Removes YouTube Shorts. A Shorts link opens as a normal video.
• Removes Instagram Reels and Facebook Reels. A single Reel someone sends you still plays, and the Reels feed stops there.
• Blocks the TikTok website.
• One switch per site. Turn any of them on or off whenever you want.

WHAT YOU KEEP
Regular YouTube videos, search and subscriptions. Instagram and Facebook posts, friends and messages. Still takes out the short videos and leaves the rest of each site as it is.

YOUR SETTINGS FOLLOW YOU
Sign-in is optional and free. Sign in with your email on each device, and your settings stay the same in Safari on your Mac, iPhone and iPad, and in the Still extensions for Chrome and Firefox. Change a setting in one place and the others follow.

STILL PRO, IF YOU WANT MORE
Still Pro is an optional one-time purchase, not a subscription. It adds twelve extra switches. Each one starts off, so you turn on only the ones you want:
• YouTube: Related videos, end-of-video suggestions, comments and live chat, plus autoplay prevention.
• Instagram: Explore recommendations, Stories and Highlights, suggested accounts and Threads links.
• Facebook: Stories, the Video tab and desktop sidebar ads.
All twelve work in Safari on your Mac. On iPhone and iPad, Still Pro offers nine of them, because end-of-video suggestions, live chat and desktop sidebar ads only appear in each site’s computer layout. Sign in with a free Still account and one purchase also works in Still for Chrome and Firefox. Still Pro never changes what’s free: removing Shorts and Reels, blocking the TikTok website and settings sync need no purchase.

SIMPLE ON PURPOSE
No timers, no streaks, no screen-time stats. Just the switches, where you want them, when you want them.

HOW IT WORKS
Still works on websites. On your Mac it works in Safari, Chrome and Firefox; on iPhone and iPad it works in Safari. It can’t change the YouTube, Instagram, Facebook or TikTok apps, so many people delete those apps and use the websites with Still instead.

PRIVATE BY DESIGN
Blocking runs on your device. Still doesn’t collect your browsing history or show ads, and it only has access to YouTube, Instagram, Facebook and TikTok. Still shares usage data, such as which switches are on, to help improve the app. It never includes the websites, pages or videos you visit, and you can turn it off in Settings.

Setup and support: https://stillapp.fit/support/
Privacy: https://stillapp.fit/privacy/
```

### V3 Still Pro in-app purchase

App Store Connect, **Monetization**, **In-App Purchases**, **Still Pro** (`still_pro_v3`), **App
Store Localization**, English (U.S.). App Store Connect’s limits are 30 characters for the display
name and 45 for the description
([Apple reference](https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/in-app-purchase-information/)).
One product serves iPhone, iPad and Mac, so the description states no number of extras (nine on a
phone, twelve on a Mac) and no price (Apple shows it).

| Box | Value | Length |
|---|---|---|
| Reference Name (internal) | Still Pro V3 | |
| Display Name | Still Pro | 9/30 |
| Description (recommended) | Fewer distractions. One-time purchase. | 38/45 |
| Description (alternative) | Hide more on YouTube, Instagram and Facebook | 44/45 |
| Review Notes (IAP) | One-time, non-consumable purchase. Open Still and tap Get Still Pro, then complete the sandbox purchase on the review device. Sign-in is offered first and can be skipped with “Buy without an account”. Restore purchase works without signing in. | 243/4000 |

The recommended description reuses the popup’s own words (“Even fewer distractions on Instagram,
Facebook and YouTube. One-time purchase.”). The runbook’s earlier draft, “Twelve extra controls.
One-time purchase.”, is not used because iPhone and iPad offer nine.

### V3 Apple App Review Information

Both platforms. **Sign-in required: Yes**, only so the reviewer can test the optional signed-in sync
and purchase paths ([ADR 0005](../adr/0005-apple-still-pro-purchase-starts-with-sign-in.md)).
Fill the private fields in the portal only:

| Portal field | Value (placeholder here, real value only in the portal) |
|---|---|
| User name | `<review email>` |
| Password | `<review code>` (the fixed six-digit review sign-in code) |
| Contact | The owner’s details (portal only) |

**Notes** (1966/4000; App Review Information, Notes; replaces every earlier 2.1 and V3 paragraph in section 3
of the 2.1 copy below):

```
Still is free to use. No account and no purchase are needed to test any blocking feature. Enable Still’s Safari extension (the app walks through it), allow it on the four supported websites and browse YouTube, Instagram, Facebook and TikTok in Safari. Shorts and Reels are removed, regular YouTube, Instagram and Facebook content stays usable and the TikTok website is blocked. Still does not change native social-media apps.

Sign-in is optional for every free feature. It only adds free settings sync, and uses an emailed six-digit code with no password. To test it, sign in with the review account in the User name and Password fields above: enter the user name as the email address, then enter the password where the app asks for the 6-digit code. Signed-in users can sign out or delete their account in the app, and blocking keeps working signed out.

Still Pro (product still_pro_v3) is an optional one-time, non-consumable purchase that adds extra switches on YouTube, Instagram and Facebook. To review it, open Still, tap Get Still Pro and complete the sandbox purchase on the review device. Signed out, sign-in is offered first and can be skipped with “Buy without an account”; signed in, Apple’s purchase sheet opens directly. Review access to Still Pro comes only from that sandbox purchase on the review device; the review account itself does not hold Still Pro. Restore purchase works without signing in. iPhone and iPad offer nine of the extras; the other three act only on the sites’ computer layouts and appear on Mac.

Usage analytics (ADR 0004): Still records product events only, for example setup steps and switch changes, never the websites, pages or videos someone visits, searches or page content. It is on by default with a “Share usage data” switch in Settings, is declared in App Privacy, is not used for tracking or advertising and does not need the App Tracking Transparency prompt. Deleting an account also deletes its analytics data.
```

### V3 Apple App Privacy label

Data used to track you: **none**. Data linked to you:

| Data type | Purposes | Linked | Tracking | V3 change |
|---|---|---|---|---|
| Contact Info → Email Address | App Functionality (sign-in, sync), Analytics | Yes | No | Kept |
| Identifiers → User ID | App Functionality, Analytics | Yes | No | Kept |
| Identifiers → Device ID | Analytics | Yes | No | Kept |
| Usage Data → Product Interaction | Analytics | Yes | No | Kept (ADR 0004) |
| Purchases → Purchase History | App Functionality (Still Pro rights), Analytics (consented purchase and refund events) | Yes | No | Added for Still Pro; confirm both purposes on screen |
| Other Data → Other Data Types | App Functionality (synced Still settings) | Yes | No | Kept |

Not collected: Browsing History, Search History, Location, Contacts, Financial Info (card details
stay with Apple). The table matches `Shared (App)/PrivacyInfo.xcprivacy`. The 2.1 table below already
lists Purchase History for historical entitlements, so in the portal this is either adding the
type or adding the Still Pro purposes to it; read the live label first (runbook 5.5, V47) and
publish only after the privacy policy (runbook 7.1) says the same.

### V3 Chrome Web Store

**Store listing tab**

| Box | Value | Length |
|---|---|---|
| Name (from the manifest) | Still: Remove Shorts & Reels, Stop Scrolling | 44/45 |
| Summary (from the manifest, recommended: unchanged) | Remove YouTube Shorts and Instagram & Facebook Reels. Block the TikTok website. Free, no timers. Syncs with Still on iPhone & Mac. | 130/132 |
| Summary (alternative, needs a manifest change) | Remove YouTube Shorts and Instagram & Facebook Reels. Block the TikTok website. Free. Optional Still Pro hides even more. | 121/132 |
| Category | Productivity (keep the current subcategory) | |
| Language | English | |
| Homepage URL | https://stillapp.fit/ | |
| Support URL | https://stillapp.fit/support/ | |

The name and summary ship inside the extension (`packages/ext-chromium/wxt.config.ts`), so the
alternative summary needs a reviewed code change and a new package; this documentation PR changes
no code. The current summary stays true in V3.

**Description** (2930/16000):

```
Still removes Shorts and Reels from the websites you use, so a quick visit stays a quick visit. Change your settings on any device, and the latest version follows you across your browsers.

FREE, NO ACCOUNT NEEDED
• Removes YouTube Shorts from the home page, search, subscriptions and the sidebar. A Shorts link opens as a normal video.
• Removes Instagram Reels and Facebook Reels. A single Reel someone sends you still plays, and the Reels feed stops there.
• Blocks the TikTok website.
• One switch per site, right in your toolbar. Turn any of them on or off whenever you want.

WHAT YOU KEEP
Regular YouTube videos, search and subscriptions. Instagram and Facebook posts, friends and messages. Still takes out the short videos and leaves the rest of each site as it is.

YOUR SETTINGS FOLLOW YOU
Sign-in is optional and free. Sign in with your email, and your settings sync between Chrome and Firefox on your computer, Safari on your Mac and Safari on your iPhone and iPad through the Still app. Change a setting here, or in the Still app on your iPhone or Mac, and your other browsers follow. Install Still on each browser or device you use.

STILL PRO, IF YOU WANT MORE
Still Pro is an optional one-time purchase of $9.99 (US price), with lifetime access and no subscription. It adds twelve extra switches. Each one starts off, so you turn on only the ones you want:
• YouTube: Related videos, end-of-video suggestions, comments and live chat, plus autoplay prevention.
• Instagram: Explore recommendations, Stories and Highlights, suggested accounts and Threads links.
• Facebook: Stories, the Video tab and desktop sidebar ads.
Buying Still Pro here needs a free Still account, so you can restore it in your other browsers. Already bought Still Pro in the Still app on iPhone or Mac? Sign in with the same account and it works here too. If Still Pro isn’t for you, you can ask for a full refund within seven days of buying. Still Pro never changes what’s free: removing Shorts and Reels, blocking the TikTok website and settings sync need no purchase.

SIMPLE ON PURPOSE
No timers, no streaks, no screen-time stats. Just the switches, where you want them, when you want them.

WHERE IT WORKS
This extension works in Chrome on desktop. Still is also available for Firefox, and for Safari on iPhone, iPad and Mac. On phones, Still works in Safari on iPhone and iPad. It doesn’t work in mobile Chrome or Firefox, or inside the YouTube, Instagram, Facebook or TikTok apps.

PRIVATE BY DESIGN
Blocking runs on your device. Still doesn’t collect your browsing history or show ads, and it only has access to YouTube, Instagram, Facebook and TikTok. Still shares usage data, such as which switches are on, to help improve the extension. It never includes the websites, pages or videos you visit, and you can turn it off in Still’s settings.

Setup and support: https://stillapp.fit/support/
Privacy: https://stillapp.fit/privacy/
```

**Privacy practices tab**

| Box | Value |
|---|---|
| Single purpose | Reduce distractions on YouTube, Instagram, Facebook and TikTok: remove YouTube Shorts and Instagram and Facebook Reels, block the TikTok website, and, with optional Still Pro, hide other parts of YouTube, Instagram and Facebook that the person chooses to switch on. |
| `storage` | Saves Still’s settings, the signed-in session and the Still Pro status on the device, so blocking works without waiting for the network. |
| `alarms` | Schedules sending of Still’s usage data at a later, random time, so when data is sent never reveals when a website was visited. Shows no permission warning. |
| `declarativeNetRequestWithHostAccess` | Opens YouTube Shorts addresses as the normal YouTube video page. |
| Host `*://*.youtube.com/*` | Removes Shorts from YouTube pages and opens Shorts links as normal videos. With Still Pro, hides the parts the person switches on: Related videos, end-of-video suggestions, comments, live chat and stops autoplay. |
| Host `*://*.instagram.com/*` | Removes Reels from Instagram pages. With Still Pro, hides the parts the person switches on: Explore recommendations, Stories and Highlights, suggested accounts and Threads links. |
| Host `*://*.facebook.com/*` | Removes Reels from Facebook pages. With Still Pro, hides the parts the person switches on: Stories, the Video tab and desktop sidebar ads. |
| Host `*://*.tiktok.com/*` | Shows Still’s blocked page instead of the TikTok website while the TikTok switch is on. |
| All four hosts (if one shared box) | Still changes only these four websites, and only to apply the person’s switches. It reads nothing from these pages to send anywhere. No other sites. |
| Remote code | No. Rule updates are signed data read by the extension’s own code. |
| Data collected (tick) | Personally identifiable information (email, only for optional sign-in); Authentication information (sign-in code and session); User activity (product interactions such as switch changes and setup steps); Financial and payment information (Still Pro purchase records only; card details are entered on the payment provider’s checkout page and never reach the extension). See open question 4. |
| Data not collected (leave unticked) | Health, Personal communications, Location, Web history, Website content. |
| Certifications (tick all three) | Not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used or transferred to determine creditworthiness or for lending. |
| Privacy policy URL | https://stillapp.fit/privacy/ |

**Test instructions** (Chrome’s reviewer field; this build never takes the fixed-code review path,
so it promises no code):

```
No account and no purchase are needed to review Still. Open YouTube, Instagram, Facebook and TikTok in Chrome: Shorts and Reels are removed, regular videos and posts stay and the TikTok website is blocked. Use the switches in Still’s toolbar popup to turn Still or any site on or off.

Sign-in is optional and only adds free settings sync. Blocking works without an account. Sign-in sends a six-digit code to the email address you enter, so use any address you can read. This extension has no fixed review code.

Still Pro is optional. To see its purchase flow, open Still’s settings (Settings in the popup) and choose Get Still Pro. You sign in first, then the web checkout opens in a new tab on a RevenueCat payment page. You don’t need to buy anything or use a test card to review the free product.
```

**Release notes / what’s new (if asked):**

```
New in 3.0: Still Pro, an optional one-time purchase that adds switches to hide more on YouTube, Instagram and Facebook. Each extra starts off. A single Reel someone sends you now plays, and Instagram profiles’ Reels tabs are hidden. Removing Shorts and Reels, blocking the TikTok website and settings sync stay free.
```

### V3 Firefox Add-ons

The first V3 Firefox release is desktop only. On the upload’s platform step, untick Firefox for
Android (runbook 6.5); the listing says nothing about Android.

| Box | Value | Length |
|---|---|---|
| Name (from the manifest) | Still: Remove Shorts & Reels, Stop Scrolling | 44/45 |
| Summary (from the manifest, recommended: unchanged) | Remove YouTube Shorts and Instagram & Facebook Reels, and block the TikTok website. Free, with no timers or stats. Sign in free to sync your settings with Chrome and with Safari on iPhone, iPad and Mac. Desktop Firefox. | 219/250 |
| Summary (alternative, needs a manifest change) | Remove YouTube Shorts and Instagram & Facebook Reels, and block the TikTok website. Free, with no timers or stats. Free sign-in syncs your settings. Optional Still Pro, a one-time purchase, hides even more. Desktop Firefox. | 223/250 |
| Categories | Social & Communication; Photos, Music & Videos | |
| Support email | support@stillapp.fit | |
| Support website | https://stillapp.fit/support/ | |
| Homepage | https://stillapp.fit/ | |
| Privacy policy | https://stillapp.fit/privacy/ (contact: privacy@stillapp.fit) | |
| License | Keep the current source-available license; never call it open source | |
| Requires payment | Leave unticked (no payment is needed to use Still); see open question 5 | |

The store build’s summary is `FIREFOX_2X_DESCRIPTION` in `packages/ext-chromium/wxt.config.ts`
(the `FIREFOX_V3_DESCRIPTION` text mentions Android and is only used by builds that declare it).

**Data-collection disclosure.** The manifest declares `authenticationInfo` as required and
`technicalAndInteraction` as optional. Firefox shows both in its install prompt. Keep every privacy
sentence consistent with that: usage data is sent only while the optional permission is granted,
and sign-in uses the email address and a sign-in code. The description’s privacy paragraph carries
this wording.

**Description** (3162/15000):

```
Still removes Shorts and Reels from the websites you use, so a quick visit stays a quick visit. Change your settings on any device, and the latest version follows you across your browsers.

FREE, NO ACCOUNT NEEDED
• Removes YouTube Shorts from the home page, search, subscriptions and the sidebar. A Shorts link opens as a normal video.
• Removes Instagram Reels and Facebook Reels. A single Reel someone sends you still plays, and the Reels feed stops there.
• Blocks the TikTok website.
• One switch per site, right in your toolbar. Turn any of them on or off whenever you want.

WHAT YOU KEEP
Regular YouTube videos, search and subscriptions. Instagram and Facebook posts, friends and messages. Still takes out the short videos and leaves the rest of each site as it is.

YOUR SETTINGS FOLLOW YOU
Sign-in is optional and free. Sign in with your email, and your settings sync between Chrome and Firefox on your computer, Safari on your Mac and Safari on your iPhone and iPad through the Still app. Change a setting here, or in the Still app on your iPhone or Mac, and your other browsers follow. Install Still on each browser or device you use.

STILL PRO, IF YOU WANT MORE
Still Pro is an optional one-time purchase of $9.99 (US price), with lifetime access and no subscription. It adds twelve extra switches. Each one starts off, so you turn on only the ones you want:
• YouTube: Related videos, end-of-video suggestions, comments and live chat, plus autoplay prevention.
• Instagram: Explore recommendations, Stories and Highlights, suggested accounts and Threads links.
• Facebook: Stories, the Video tab and desktop sidebar ads.
Buying Still Pro here needs a free Still account, so you can restore it in your other browsers. Already bought Still Pro in the Still app on iPhone or Mac? Sign in with the same account and it works here too. If Still Pro isn’t for you, you can ask for a full refund within seven days of buying. Still Pro never changes what’s free: removing Shorts and Reels, blocking the TikTok website and settings sync need no purchase.

SIMPLE ON PURPOSE
No timers, no streaks, no screen-time stats. Just the switches, where you want them, when you want them.

WHERE IT WORKS
This extension works in Firefox on desktop. Still is also available for Chrome, and for Safari on iPhone, iPad and Mac. On phones, Still works in Safari on iPhone and iPad. It doesn’t work in mobile Chrome or Firefox, or inside the YouTube, Instagram, Facebook or TikTok apps.

PRIVATE BY DESIGN
Blocking runs on your device. Still doesn’t collect your browsing history or show ads, and it only has access to YouTube, Instagram, Facebook and TikTok. Firefox asks whether you allow Still to collect “technical and interaction data”. Still uses it only for usage data that helps improve Still, such as which switches are on. It stays off unless you allow it, you can change it anytime in Still’s settings and it never includes the websites, pages or videos you visit. Signing in uses your email address and a sign-in code, which Firefox lists as authentication information.

Setup and support: https://stillapp.fit/support/
Privacy: https://stillapp.fit/privacy/
```

**Notes to reviewer** (no fixed code: the browser builds never take the review path):

```
No account and no purchase are needed to review Still. Open YouTube, Instagram, Facebook and TikTok in Firefox: Shorts and Reels are removed, regular videos and posts stay and the TikTok website is blocked. Use the switches in Still’s toolbar popup to turn Still or any site on or off.

Sign-in is optional and only adds free settings sync. Blocking works without an account. Sign-in sends a six-digit code to the email address you enter, so use any address you can read. This extension has no fixed review code.

Still Pro is optional. To see its purchase flow, open Still’s settings (Settings in the popup) and choose Get Still Pro. You sign in first, then the web checkout opens in a new tab on a RevenueCat payment page. You don’t need to buy anything or use a test card to review the free product.

Usage data is the optional “technicalAndInteraction” data-collection permission. Nothing is sent unless it is granted, at install or later from Still’s settings. It records product events only, never page addresses, videos, searches or page content. Host permissions are limited to YouTube, Instagram, Facebook and TikTok. This release is for desktop Firefox.

The complete source archive includes the pnpm workspace, frozen lockfile, public build configuration and AMO-REBUILD.mjs. Follow that file’s prerequisites and run `node AMO-REBUILD.mjs` to reproduce the submitted Firefox payload. Remote rule updates are signed data, not executable code.
```

**Release notes:** the Chrome text above.

**Screenshot captions:** see the assets list below.

### V3 assets needed

Sizes are from the [store-ready manifest](screenshots/store-ready/README.md). The accuracy rule
there applies: every picture must match the 3.0 build it ships with.

**App Store (iPhone, iPad, Mac)**

- [ ] iPhone 6.9” set, 1320×2868: recapture the screens that show Still itself (`iphone-03-switches`,
  `iphone-06-safari-menu`, `iphone-07-setup`) from the 3.0 build; add one Still Pro frame (the
  settings list with the extras, captioned with what Pro adds, no count).
- [ ] iPad 13” set, 2064×2752: recapture all three (`ipad-01-safari-popup`, `ipad-02-switches`,
  `ipad-03-setup` all show Still’s 2.1 interface); add the same Still Pro frame.
- [ ] Mac set, 2880×1800: recapture `mac-05-app` and `mac-06-chrome`; add one Still Pro frame.
- [ ] Still Pro in-app purchase **App Review screenshot** (review only, not shown to customers): a
  full-screen capture of the Still Pro purchase screen with Get Still Pro, from the 3.0 iPhone
  build (1320×2868 is accepted). This is the missing item in runbook 5.2d and V43.
- [ ] Optional promoted-purchase image, 1024×1024: reuse `apple/still-pro-iap-v3-1024x1024.jpg`
  only if the owner decides to promote the purchase; its compliance rules are in the manifest.

**Chrome Web Store** (1280×800, five allowed)

- [ ] Recapture `chrome-05-switches` (V3 popup); replace one slot with a Still Pro frame (the
  settings page’s Still Pro card or the extras in the popup).
- [ ] Promo tiles: reuse `still-chrome-promo-v2-440x280.jpg` (required) and
  `still-chrome-marquee-v2-1400x560.jpg`.

**Firefox Add-ons** (1280×800)

- [ ] Same changes as Chrome, taken in Firefox, with captions in AMO’s fields. Suggested Pro
  caption: “Optional Still Pro adds switches to hide more on YouTube, Instagram and Facebook.”

**Reuse from 2.1 after an owner check against the 3.0 build**

- The website before/after frames: `*-01-youtube`, `*-02-instagram`, `*-04-facebook` (iPhone),
  `*-03-facebook` (Mac, Chrome, Firefox). The free removal is unchanged; reuse them if the pictured
  pages still look the same.
- The TikTok frames (`iphone-05-tiktok`, `mac-04-tiktok`, `chrome-04-tiktok`,
  `firefox-04-tiktok`): V3 has its own blocked page (`TikTokBlocked.svelte`), so compare and
  recapture if it changed.
- App icon and store icons: reuse.

### Open questions for the experiment

1. **Summaries.** Keep the current Chrome and Firefox summaries (recommended, no code change), or
   adopt the alternatives that name Still Pro (needs a manifest PR, a package rebuild and the
   manifest tests updated)?
2. **Keywords.** Approve dropping “remove” and “web” for “comments”.
3. **Counting extras.** The in-product rule (ISS-0029) is that no Still Pro surface states a number.
   This draft says “twelve” only in the Mac, Chrome and Firefox listings, where all twelve work, and
   states no number in the iPhone listing’s lead or in the in-app purchase. Keep, or drop the
   number from every listing?
4. **Chrome “Financial and payment information”.** Recommended ticked, because Still keeps Still Pro
   purchase records (runbook 6.3 “purchase status”). Confirm.
5. **AMO “Requires payment”.** Recommended unticked, because every free feature works without
   paying and the description explains Still Pro. Confirm.
6. **Firefox manifest declarations.** The manifest declares `authenticationInfo` (required) and
   `technicalAndInteraction` (optional) only. Whether the email address
   (`personallyIdentifyingInfo`) or Still Pro purchase status (`financialAndPaymentInfo`) also
   need declaring is a privacy-review question for a code PR; this listing claims nothing beyond the
   manifest.
7. **Price and refund in the browser listings.** Chrome and Firefox copy says “$9.99 (US price)”
   and the seven-day web refund. The Apple copy names no price (Apple shows it). Confirm both.
8. **Web purchase on Apple devices.** No listing claims that a Chrome or Firefox purchase unlocks
   Safari. The Chrome and Firefox copy only says an Apple purchase works there after signing in
   (as the Apple review notes state). Confirm before adding anything more.

## Shipped 2.1 copy (reference)

<details>
<summary>Show the shipped 2.1 listing copy</summary>

**Still 2.1 store listing copy (shipped).** Kept for reference; the V3 copy above is current.

Updated September 23, 2026. Canonical English copy for the 2.1 release on every store, positioned
around "Your settings follow you": Still removes Shorts and Reels in Safari, Chrome and Firefox, and
the latest settings follow people between their devices. Every length below was checked against the
store's limit. The 2.0 copy is in Git history.

Apple's name, subtitle, keywords and What's New change only with a new app version; promotional text
can change anytime. Chrome and Firefox read the name and summary from the extension manifest
(`packages/ext-chromium/wxt.config.ts`), so those ship in the 2.1 build. Owner edits made directly in a
portal are intentional; merge them rather than overwrite them. Use
[public contact addresses](public-contact-addresses.md) and the [release runbook](README.md) for
screenshots, privacy declarations and pricing checks. Never put review credentials in this file.

Accuracy rules: Still removes Shorts and Reels and never claims to hide feeds, Stories, Explore or
comments; the whole TikTok website is blocked; on phones Still works in Safari on iPhone and iPad
(never mobile Chrome, mobile Firefox or native apps; Firefox on Android is deferred to a later
update); sync needs a free
sign-in on each device; say "free", never "free forever"; never "everywhere"; never "no tracking"
(say "no timers, no screen-time stats").

## 1. Apple — App Information (shared by iPhone and Mac)

| Box | Value | Length |
|---|---|---|
| Name | Still: Reels & Shorts Blocker | 29/30 |
| Subtitle | Block Short Videos in Safari | 28/30 |
| Primary category | Productivity (unchanged) | |
| Secondary category | Utilities (unchanged) | |
| Privacy Policy URL | https://stillapp.fit/privacy/ | |
| Content rights, age rating | Unchanged | |

Subtitle: every word is true and searched (block, short videos, Safari). "Safari" in the first line
people read heads off "doesn't work in the Instagram app" reviews.

## 2. Apple — version 2.1, iPhone and iPad (iOS)

| Box | Value | Length |
|---|---|---|
| Promotional Text | Shorts and Reels, gone from the websites you use. Change your settings anytime and they follow you to Safari on iPhone, iPad and Mac, plus Chrome and Firefox. Free. | 164/170 |
| Keywords | `remove,hide,stop,scroll,focus,social,media,screen,time,detox,doomscroll,brainrot,extension,web,form` | 99/100 bytes |
| Support URL | https://stillapp.fit/support/ | |
| Marketing URL | https://stillapp.fit/ | |
| Version | 2.1.0 | |
| Copyright | © 2026 Cadmus Labs (the live value has a stray leading space; remove it) | |
| What's New | New in 2.1: a "Share usage data" switch. Still now shares how the app is used, such as which settings are turned on and whether setup finished, to help us improve it. It never includes the pages or videos you visit. You can turn it off anytime in Settings. | 256/4000 |

**Description** (1977/4000):

```
Still removes Shorts and Reels from the websites you use, so a quick visit stays a quick visit. Change your settings on any device, and the latest version follows you between your phone and your computer.

WHAT STILL DOES
• Removes YouTube Shorts. A Shorts link opens as a normal video.
• Removes Instagram Reels and Facebook Reels.
• Blocks the TikTok website.
• One switch per site. Turn any of them on or off whenever you want, from any device.

WHAT YOU KEEP
Regular YouTube videos, search and subscriptions. Instagram and Facebook posts, friends and messages. Still takes out the short videos and leaves the rest of each site as it is.

YOUR SETTINGS FOLLOW YOU
Choose what's blocked in the Still app on your iPhone or your Mac, and change it whenever you like. Sign in free with your email on each device, and your latest settings reach Safari on your iPhone, iPad and Mac, and the Still extensions for Chrome and Firefox on your computer. Change a setting in one place and the others follow.

NO LOGGING IN TO ANOTHER APP
Still works in the Safari, Chrome or Firefox you already use, signed in as you. There's no separate browser to log in to.

SIMPLE ON PURPOSE
No timers, no streaks, no screen-time stats. Just the blocking, where you want it, when you want it.

FREE
Blocking needs no account and no purchase. Sign-in is optional and only adds sync.

HOW IT WORKS
Still works on websites. On iPhone and iPad it works in Safari; on your computer it works in Safari, Chrome and Firefox. It can't change the YouTube, Instagram, Facebook or TikTok apps, so many people delete those apps and use the websites with Still instead.

PRIVATE BY DESIGN
Blocking runs on your device. Still doesn't collect your browsing history or show ads, and it only has access to YouTube, Instagram, Facebook and TikTok. Still shares usage data to help improve the app; you can turn it off in Settings.

Setup and support: https://stillapp.fit/support/
Privacy: https://stillapp.fit/privacy/
```

## 2. Apple — version 2.1, Mac (macOS)

| Box | Value | Length |
|---|---|---|
| Promotional Text | Shorts and Reels, gone from Safari, Chrome and Firefox on your Mac. Control them all from the Still app, and your settings follow you to your iPhone and iPad. Free. | 164/170 |
| Keywords | `remove,hide,stop,scroll,focus,social,media,screen,time,detox,doomscroll,brainrot,extension,web,form` | 99/100 bytes |
| Support URL | https://stillapp.fit/support/ | |
| Marketing URL | https://stillapp.fit/ | |
| Version | 2.1.0 | |
| Copyright | © 2026 Cadmus Labs (the live value has a stray leading space; remove it) | |
| What's New | New in 2.1: a "Share usage data" switch. Still now shares how the app is used, such as which settings are turned on and whether setup finished, to help us improve it. It never includes the pages or videos you visit. You can turn it off anytime in Settings. | 256/4000 |

**Description** (2045/4000):

```
Still removes Shorts and Reels from Safari, Chrome and Firefox on your Mac, so a quick visit stays a quick visit. Control them all from the Still app on your Mac (Chrome and Firefox use Still's free extensions), and your latest settings follow you to your iPhone and iPad.

WHAT STILL DOES
• Removes YouTube Shorts. A Shorts link opens as a normal video.
• Removes Instagram Reels and Facebook Reels.
• Blocks the TikTok website.
• One switch per site. Turn any of them on or off whenever you want, from any device.

WHAT YOU KEEP
Regular YouTube videos, search and subscriptions. Instagram and Facebook posts, friends and messages. Still takes out the short videos and leaves the rest of each site as it is.

YOUR SETTINGS FOLLOW YOU
Choose what's blocked in the Still app on your iPhone or your Mac, and change it whenever you like. Sign in free with your email on each device, and your latest settings reach Safari on your iPhone, iPad and Mac, and the Still extensions for Chrome and Firefox on your computer. Change a setting in one place and the others follow.

NO LOGGING IN TO ANOTHER APP
Still works in the Safari, Chrome or Firefox you already use, signed in as you. There's no separate browser to log in to.

SIMPLE ON PURPOSE
No timers, no streaks, no screen-time stats. Just the blocking, where you want it, when you want it.

FREE
Blocking needs no account and no purchase. Sign-in is optional and only adds sync.

HOW IT WORKS
Still works on websites. On iPhone and iPad it works in Safari; on your computer it works in Safari, Chrome and Firefox. It can't change the YouTube, Instagram, Facebook or TikTok apps, so many people delete those apps and use the websites with Still instead.

PRIVATE BY DESIGN
Blocking runs on your device. Still doesn't collect your browsing history or show ads, and it only has access to YouTube, Instagram, Facebook and TikTok. Still shares usage data to help improve the app; you can turn it off in Settings.

Setup and support: https://stillapp.fit/support/
Privacy: https://stillapp.fit/privacy/
```

## 3. Apple — App Review Information (both platforms)

- Sign-in required: **No** (blocking needs no account). Put any review sign-in details only in the
  private portal fields, never in this file.
- V3 submission (Still Pro on, [ADR 0005](../adr/0005-apple-still-pro-purchase-starts-with-sign-in.md)):
  sign-in is offered before a Still Pro purchase and can always be skipped, so the purchase itself
  never requires it. Answer **Sign-in required: Yes** only to hand the reviewer the review account
  for the signed-in purchase and sync paths; the real details go in the portal fields only, never
  here. Add the V3 Still Pro paragraph below to the notes.
- Contact: the owner's details (portal only). Notes:

```
Still is free. No purchase or account is needed to test any blocking feature. Enable the Safari extension, allow access to the four supported websites, and browse them in Safari. Regular YouTube videos and regular Instagram/Facebook content should remain usable; the TikTok website is blocked.

Sign-in is optional and enables free cross-device settings sync. It uses an emailed six-digit code. Signed-in users can sign out or delete their account in the app. Blocking remains available while signed out. Still does not modify native social-media apps.

New in 2.1: first-party usage analytics with a one-time notice and a "Share usage data" switch in Settings. It records product events only (for example, setup steps and switch changes); never page addresses, videos, searches or page content. It is declared in the App Privacy section, is not used for tracking or advertising, and the App Tracking Transparency prompt is not required. Deleting an account also deletes its analytics data.

V3 copy (use instead of the 2.1 paragraph above for a V3 submission; ADR 0004, 2026-10-12): First-party usage analytics is on by default, with a single "Share usage data" switch in Settings (no separate one-time notice). It records product events only (for example, setup steps and switch changes); never the websites, pages or videos someone visits, searches or page content. It is declared in the App Privacy section, is not used for tracking or advertising, and the App Tracking Transparency prompt is not required. Deleting an account also deletes its analytics data.

Purchase infrastructure remains in the project for historical entitlements, with paid features disabled. No in-app purchase is needed to use Still.

V3 Still Pro copy (use instead of the paragraph above for a V3 submission with Still Pro on; ADR 0005, 2026-10-16; replace [review account] in the portal only): Still Pro is a one-time purchase that unlocks twelve extra controls in Safari on this device and in Still for Chrome and Firefox on the person's other computers. The Still account (an emailed six-digit code, no password) is how one purchase reaches the browsers that are not on Apple devices. Blocking YouTube Shorts and Reels, and settings sync, need no account and no purchase. Restore purchase works without signing in. Sign-in details for review: [review account]. Signing in is offered before purchase and can be skipped with 'Buy without an account'.
```

## 4. Apple — App Privacy (the label)

Data used to track you: **none**. Data linked to you, all collected for the purposes shown:

| Data type | Purposes | Linked | Tracking |
|---|---|---|---|
| Contact Info → Email Address | App Functionality (sign-in, sync), Analytics | Yes | No |
| Identifiers → User ID | App Functionality, Analytics | Yes | No |
| Identifiers → Device ID | Analytics | Yes | No |
| Usage Data → Product Interaction | Analytics | Yes | No |
| Purchases → Purchase History | App Functionality (purchase rights and entitlements), Analytics (purchase/refund measurement) | Yes | No |
| Other Data → Other Data Types | App Functionality (the synced Still settings: which sites are switched on) | Yes | No |

Not collected: Browsing History, Search History, Location, Contacts, Diagnostics beyond the above.
This table matches `Shared (App)/PrivacyInfo.xcprivacy` exactly (six types); the Safari extension's
manifest declares a subset (Product Interaction, Device ID, User ID).
Purchase History stays declared for historical entitlements as well as V3 purchases. Before the
V3 Apple analytics build is submitted, confirm **Analytics** and **App Functionality** are both
selected for Purchase History in App Store Connect, with **Linked to you: Yes** and **Tracking: No**.
This remains linked data even for pseudonymous device identifiers; it is not a claim of anonymized
collection. The canonical events are sent only from the originating Apple app under original and
current sharing permission. The Safari extension does not send purchase/refund events, so its
manifest keeps the three-type subset above. No card details, browsing history or additional data
type is introduced by this change.

The label must match the final app privacy manifest and published notice. Apple's
[privacy details guidance](https://developer.apple.com/app-store/app-privacy-details/) requires all
applicable uses to be declared and distinguishes purchase history, analytics and advertising tracking.
Repository edits do not update the portal label; record the owner-confirmed portal change separately.

## 5. Apple — screenshots (images, not text boxes; captions to put on them)

iPhone (first three appear in search results):
1. "Shorts and Reels, gone." · small: "YouTube · Instagram · Facebook · TikTok" (before/after, YouTube in Safari)
2. "Change it on your phone or your Mac. Your browsers follow." (Still on iPhone and Mac, Chrome beside them)
3. "Delete the app. Keep the website." (Instagram in Safari, posts and messages, no Reels)
4. "One switch per site. No timers. No stats." (the Still switches)
5. "Free. No account needed to block."
6. "Works in Safari on iPhone, iPad and Mac, and in Chrome and Firefox."

Mac: 1. before/after on a Mac, "Shorts and Reels, gone from Safari, Chrome and Firefox." 2. "Control
them all from your Mac. Your iPhone follows." 3–6 as above.

## 6. Chrome Web Store

**Store listing tab**

| Box | Value | Length |
|---|---|---|
| Name (from the extension's manifest) | Still: Remove Shorts & Reels, Stop Scrolling | 44/45 (Firefox's manifest limit applies to both) |
| Summary (from the manifest) | Remove YouTube Shorts and Instagram & Facebook Reels. Block the TikTok website. Free, no timers. Syncs with Still on iPhone & Mac. | 130/132 |
| Category | Keep the current category | |
| Language | English | |
| Official URL / Homepage URL | https://stillapp.fit/ | |
| Support URL | https://stillapp.fit/support/ | |
| Screenshots (1280×800) | 1. "Shorts and Reels, gone." (desktop YouTube before/after) 2. "Your settings follow you: Chrome, Firefox, and Safari on iPhone and Mac." 3. "One switch per site, right in your toolbar." 4. "Free. No account needed to block." | |
| Small promo tile (440×280) | "Shorts & Reels, gone." with the Still logo | |
| YouTube video | Leave empty until a preview video exists | |

**Description** (2019/16000). Firefox on Android is deferred to a later update, so the phones
sentence ends at "Safari on iPhone and iPad":

```
Still removes Shorts and Reels from the websites you use, so a quick visit stays a quick visit. Change your settings on any device, and the latest version follows you across your browsers.

WHAT STILL DOES
• Removes YouTube Shorts from the home page, search, subscriptions and the sidebar. A Shorts link opens as a normal video.
• Removes Instagram Reels and Facebook Reels.
• Blocks the TikTok website.
• One switch per site, right in your toolbar. Turn any of them on or off whenever you want.

WHAT YOU KEEP
Regular YouTube videos, search and subscriptions. Instagram and Facebook posts, friends and messages. Still takes out the short videos and leaves the rest of each site as it is.

YOUR SETTINGS FOLLOW YOU
Sign in free with your email, and your settings sync between Chrome and Firefox on your computer, Safari on your Mac, and Safari on your iPhone and iPad through the Still app. Change it here, or in the Still app on your iPhone or Mac, and your other browsers follow. Install Still on each browser or device you use.

NO LOGGING IN TO ANOTHER APP
Still works in the Safari, Chrome or Firefox you already use, signed in as you. There's no separate browser to log in to.

SIMPLE ON PURPOSE
No timers, no streaks, no screen-time stats, no wall of options. One switch per site.

FREE
Blocking needs no account and no purchase. Sign-in is optional and only adds sync.

WHERE IT WORKS
This extension works in Chrome on desktop. Still is also available for Firefox, and for Safari on iPhone, iPad and Mac. On phones, Still works in Safari on iPhone and iPad. It doesn't work in mobile Chrome or Firefox, or inside the YouTube, Instagram, Facebook or TikTok apps.

PRIVATE BY DESIGN
Blocking runs on your device. Still doesn't collect your browsing history or show ads, and it only has access to YouTube, Instagram, Facebook and TikTok. Still shares usage data to help improve the extension; you can turn it off in settings.

Setup and support: https://stillapp.fit/support/
Privacy: https://stillapp.fit/privacy/
```

**Privacy practices tab**

| Box | Value |
|---|---|
| Single purpose | Remove YouTube Shorts and Instagram/Facebook Reels, and block the TikTok website, so people can use those websites with fewer short-form video distractions. |
| `storage` | Saves Still's settings and the signed-in session on the device. |
| `alarms` | Schedules sending of Still's usage data at a later, random time, so the time data is sent never reveals when a website was visited. Shows no permission warning. |
| `declarativeNetRequestWithHostAccess` | Redirects YouTube Shorts addresses to the normal YouTube video page. |
| Host permissions | Applies blocking only on YouTube, Instagram, Facebook and TikTok. No other sites. |
| Remote code | No. Rule updates are signed data read by the extension's own code. |
| Data collected (tick) | Personally identifiable information (email, only for optional sign-in); Authentication information (sign-in code and session); User activity (product interactions such as switch changes and setup steps). |
| Data not collected (leave unticked) | Health, Financial, Personal communications, Location, Web history, Website content. |
| Certifications (tick all three) | Not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used or transferred to determine creditworthiness or for lending. |
| Privacy policy URL | https://stillapp.fit/privacy/ |

**Release notes / what's new (if asked):** New in 2.1: a "Share usage data" switch in settings. Still can share how the extension is used, such as which switches are on and whether setup finished, to help us improve it. It never includes the pages or videos you visit. You can turn it off anytime.

## 7. Firefox Add-ons (AMO)

The first V3 Firefox release is desktop only; Firefox on Android is deferred to a later update. Keep
the desktop-only summary until then.

| Box | Value | Length |
|---|---|---|
| Name (from the manifest) | Still: Remove Shorts & Reels, Stop Scrolling | 44/45 |
| Summary | Remove YouTube Shorts and Instagram & Facebook Reels, and block the TikTok website. Free, with no timers or stats. Sign in free to sync your settings with Chrome and with Safari on iPhone, iPad and Mac. Desktop Firefox. | 219/250 |
| Categories | Social & Communication; Photos, Music & Videos | |
| Support email | support@stillapp.fit | |
| Support website | https://stillapp.fit/support/ | |
| Homepage | https://stillapp.fit/ | |
| Privacy policy | https://stillapp.fit/privacy/ (contact: privacy@stillapp.fit) | |
| License | Keep the current source-available license; never call it open source | |
| Requires payment | No | |
| Release notes | New in 2.1: a "Share usage data" switch in settings. Still can share how the extension is used, such as which switches are on and whether setup finished, to help us improve it. It never includes the pages or videos you visit. On Firefox it stays off unless you allow it. | |

**Description** (2023/15000):

```
Still removes Shorts and Reels from the websites you use, so a quick visit stays a quick visit. Change your settings on any device, and the latest version follows you across your browsers.

WHAT STILL DOES
• Removes YouTube Shorts from the home page, search, subscriptions and the sidebar. A Shorts link opens as a normal video.
• Removes Instagram Reels and Facebook Reels.
• Blocks the TikTok website.
• One switch per site, right in your toolbar. Turn any of them on or off whenever you want.

WHAT YOU KEEP
Regular YouTube videos, search and subscriptions. Instagram and Facebook posts, friends and messages. Still takes out the short videos and leaves the rest of each site as it is.

YOUR SETTINGS FOLLOW YOU
Sign in free with your email, and your settings sync between Chrome and Firefox on your computer, Safari on your Mac, and Safari on your iPhone and iPad through the Still app. Change it here, or in the Still app on your iPhone or Mac, and your other browsers follow. Install Still on each browser or device you use.

NO LOGGING IN TO ANOTHER APP
Still works in the Safari, Chrome or Firefox you already use, signed in as you. There's no separate browser to log in to.

SIMPLE ON PURPOSE
No timers, no streaks, no screen-time stats, no wall of options. One switch per site.

FREE
Blocking needs no account and no purchase. Sign-in is optional and only adds sync.

WHERE IT WORKS
This extension works in Firefox on desktop. Still is also available for Chrome, and for Safari on iPhone, iPad and Mac. On phones, Still works in Safari on iPhone and iPad. It doesn't work in mobile Chrome or Firefox, or inside the YouTube, Instagram, Facebook or TikTok apps.

PRIVATE BY DESIGN
Blocking runs on your device. Still doesn't collect your browsing history or show ads, and it only has access to YouTube, Instagram, Facebook and TikTok. You can choose to share usage data to help improve Still; it stays off unless you allow it.

Setup and support: https://stillapp.fit/support/
Privacy: https://stillapp.fit/privacy/
```

**Notes to reviewer:**

```
All blocking and optional settings sync are free. No account or purchase is needed for blocking. Sign-in uses an emailed six-digit code. Host permissions are limited to YouTube, Instagram, Facebook and TikTok. This release works in desktop Firefox only; it is not listed for Firefox for Android.

New in 2.1: optional usage analytics declared as the optional "technicalAndInteraction" data collection permission. Nothing is sent unless the user grants it (at install or later from Still's settings). It records product events only, never page addresses, videos, searches or page content.

The complete source archive includes the pnpm workspace, frozen lockfile, public build configuration, and AMO-REBUILD.mjs. Follow that file's prerequisites and run `node AMO-REBUILD.mjs` to reproduce the submitted Firefox payload. Remote rule updates are signed data, not executable code.
```

**Screenshots:** the Chrome set, taken in Firefox.

## Customer support responses

Moved and updated: see [3.0 support replies](#30-support-replies). The 2.1 earlier-purchase reply
("Update to Still 2.0 ... No purchase restore is needed.") is false in 3.0 and is kept only in Git
history.

</details>
