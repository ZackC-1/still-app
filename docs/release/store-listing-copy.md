# Still 2.0 store listing copy

Updated September 11, 2026. Canonical English copy for the free 2.0 release. Prepare these fields
now; publish alongside the corresponding 2.0 artifacts. A listing for an older paid version must
not imply that its download already includes free 2.0 functionality.

Use [public contact addresses](public-contact-addresses.md) for every submission. Store screenshots,
provider privacy declarations, and live portal pricing still need the checks in the
[release runbook](README.md). Do not upload historical images showing Pro locks or $1.99 pricing.

## Shared product language

- **Still 2.0 is free.** Remove YouTube Shorts and Instagram/Facebook Reels; block the TikTok website.
- **No account or purchase needed for blocking.** Sign-in is optional and enables free settings sync.
- **Every supported surface:** Safari on iPhone, iPad, and Mac; Chrome and Firefox on desktop.
- **Mobile means Safari websites.** Still does not block inside native social-media apps.
- No “free forever” promise. Future pricing is outside this release.

## Apple App Store: iPhone/iPad and Mac

Name (30-character limit):

> Still: Block Shorts & Reels

Subtitle (30-character limit):

> A quieter web in Safari

Promotional text (170-character limit):

> Still 2.0 is free. Remove YouTube Shorts and Instagram/Facebook Reels, and block the TikTok website in Safari. No account or purchase needed.

Keywords (100-byte limit):

> focus,distraction,doomscroll,attention,mindful,video,feed,scroll,website,hide,remove,calm,browser

The 97-byte keyword field avoids terms already present in the name, subtitle, or selected
Productivity/Utilities categories. It uses relevant functional terms without competing app names;
supported websites remain named in the description. Follow [Apple's search guidance](https://developer.apple.com/app-store/search/)
when revising it. These choices do not establish search volume or guarantee ranking.

Description (use for both Apple listings):

> OPEN FOR WHAT YOU CAME FOR
>
> Still removes short-form distractions from websites in Safari, so a quick visit can stay a quick visit.
>
> Use Still on your computer and iPhone, with optional free settings sync between supported browsers.
>
> ALL INCLUDED FREE IN STILL 2.0
> • Remove YouTube Shorts shelves and tabs
> • Open Shorts links in the normal YouTube video player
> • Remove Instagram Reels and Facebook Reels
> • Block the TikTok website
> • Choose which supported websites to quiet
>
> Regular videos, posts, and messages on YouTube, Instagram, and Facebook remain available. The TikTok website is blocked.
>
> NO ACCOUNT NEEDED
> Enable the Safari extension and allow it on the websites you want to quiet. All blocking works without sign-in or a purchase. Settings can stay on your device.
>
> FREE SYNC BETWEEN COMPUTER AND PHONE
> Keep your blocking settings consistent across Chrome and Firefox on your computer, Safari on Mac, and Safari on iPhone and iPad through the Still iOS app. Install Still separately on each browser or device, then sign in with the same email address using the emailed code. Settings sync is optional and free; blocking works without an account.
>
> WHERE IT WORKS
> Safari on iPhone, iPad, and Mac. Still is also available separately for Chrome and Firefox on desktop.
>
> On iPhone and iPad, Still works only on websites opened in Safari. It cannot block short-form video inside the native YouTube, Instagram, Facebook, or TikTok apps.
>
> PRIVATE BY DESIGN
> Blocking runs on your device. Still does not collect browsing history or show ads. Website access is limited to YouTube, Instagram, Facebook, and TikTok.
>
> Setup and support: https://stillapp.fit/support/
> Privacy: https://stillapp.fit/privacy/

What's New (both Apple listings and browser release notes):

> Still 2.0 includes all blocking features for free, with no account or purchase needed. Remove YouTube Shorts and Instagram/Facebook Reels, and block the TikTok website. Optional free sign-in syncs your settings between Chrome and Firefox on your computer, Safari on Mac, and Safari on iPhone and iPad through the Still iOS app.

Reviewer notes:

> Still 2.0 is free. No purchase or account is needed to test any blocking feature. Enable the Safari extension, grant access to the four supported websites, and browse them in Safari. Regular YouTube videos and regular Instagram/Facebook content should remain usable; the TikTok website is blocked.
>
> Sign-in is optional and enables free cross-device settings sync. It uses an emailed six-digit code. Users can request an export of their account data by emailing privacy@stillapp.fit. Signed-in users can sign out or delete their account in the app. Blocking remains available while signed out. Still does not modify native social-media apps.
>
> Purchase infrastructure remains in the project for historical entitlements, with paid features disabled for this release. No in-app purchase is needed to use Still 2.0.

Before submission, supply any review-only account access through the private portal fields and
verify it works; never put credentials in this document. Confirm app price is free and that obsolete
promoted purchases, purchase screenshots, and paid promotional text are not attached to this release.
Do not delete historical products or customer entitlements just to update metadata.

## Chrome Web Store

Name:

> Still: Block Shorts & Reels

Short description (132-character limit):

> Remove Shorts and Reels. Block the TikTok website. Free, with no account needed. Optional free settings sync.

Detailed description:

> OPEN FOR WHAT YOU CAME FOR
>
> Still removes short-form distractions from websites in your desktop browser, so a quick visit can stay a quick visit.
>
> Use Still on your computer and iPhone, with optional free settings sync between supported browsers.
>
> ALL INCLUDED FREE IN STILL 2.0
> • Remove YouTube Shorts shelves and tabs
> • Open Shorts links in the normal YouTube video player
> • Remove Instagram Reels and Facebook Reels
> • Block the TikTok website
> • Choose which supported websites to quiet
>
> Regular videos, posts, and messages on YouTube, Instagram, and Facebook remain available. The TikTok website is blocked.
>
> NO ACCOUNT NEEDED
> Install Still, open it from the toolbar, and choose your settings. All blocking works without sign-in or a purchase. Settings can stay on your device.
>
> FREE SYNC BETWEEN COMPUTER AND PHONE
> Keep your blocking settings consistent across Chrome and Firefox on your computer, Safari on Mac, and Safari on iPhone and iPad through the Still iOS app. Install Still separately on each browser or device, then sign in with the same email address using the emailed code. Settings sync is optional and free; blocking works without an account.
>
> WHERE IT WORKS
> Chrome and Firefox on desktop. Still is also available separately for Safari on iPhone, iPad, and Mac.
>
> On iPhone and iPad, Still works only on websites opened in Safari. It cannot block short-form video inside native YouTube, Instagram, Facebook, or TikTok apps. This desktop extension does not work in mobile Chrome or Firefox.
>
> PRIVATE BY DESIGN
> Blocking runs on your device. Still does not collect browsing history or show ads. Website access is limited to YouTube, Instagram, Facebook, and TikTok.
>
> Setup and support: https://stillapp.fit/support/
> Privacy: https://stillapp.fit/privacy/

Single purpose:

> Remove YouTube Shorts and Instagram/Facebook Reels, and block the TikTok website, so users can browse supported websites with fewer short-form distractions.

Permission justifications:

- `declarativeNetRequestWithHostAccess`: Redirect YouTube Shorts URLs to the standard watch page.
- `storage`: Save Still settings and local session state.
- Host permissions: Apply blocking rules only on YouTube, Instagram, Facebook, and TikTok.

Payment: no purchase required for any 2.0 functionality. Remove paid-feature/checkout descriptions.
Remote executable code: no. Signed remote rule updates are data interpreted by bundled code.
Finalize data declarations after the provider/privacy gate; optional sign-in processes authentication
information and settings. Do not reuse the old claim that signed-out clients make no network requests.

## Firefox Add-ons

Name:

> Still: Block Shorts & Reels

Summary (250-character limit):

> Remove YouTube Shorts and Instagram/Facebook Reels, and block the TikTok website for free. No account needed. Optional free settings sync with desktop Chrome and Safari on Mac, iPhone, and iPad. This extension supports desktop Firefox.

Description: use the Chrome detailed description above. Release notes: use What's New above.

Payment: mark no payment required for 2.0 functionality. Keep the actual source-available license;
do not describe Still as open-source licensed. Finalize data declarations after the provider/privacy
gate, including optional authentication and sync data.

Reviewer notes:

> All blocking and optional settings sync are free in 2.0. No account or purchase is needed for blocking. Sign-in uses an emailed six-digit code. Host permissions are limited to YouTube, Instagram, Facebook, and TikTok. This release supports desktop Firefox.
>
> The complete source archive includes the pnpm workspace, frozen lockfile, public build configuration, and AMO-REBUILD.mjs. Follow that file's prerequisites and run `node AMO-REBUILD.mjs` to reproduce the submitted Firefox payload. Remote rule updates are signed data, not executable code.

Screenshot description:

> Still 2.0 removes Shorts and Reels and blocks the TikTok website for free. Sign-in is optional for settings sync.

## Customer support responses

Native-app question:

> On iPhone and iPad, Still works on websites opened in Safari. It cannot change the native YouTube, Instagram, Facebook, or TikTok apps. Setup help: https://stillapp.fit/setup/

Earlier Pro purchase:

> Update to Still 2.0 to use all blocking and optional settings sync for free. No purchase restore is needed. For help with an earlier receipt or refund, email support@stillapp.fit. Apple reviews Apple purchase refunds; earlier web purchases have a 14-day refund window. Details: https://stillapp.fit/support/

Privacy or data request:

> Email privacy@stillapp.fit for help with your Still account data.
