# Track 5 (future) — Google Play

**There is no Google Play track for Still today, and nothing to submit.** This file explains why and
what it would take, so the option isn't lost.

## Why Google Play doesn't apply yet

Google Play distributes **native Android apps** (APK/AAB). Still has:
- an **Apple** app (iOS + Mac) — App Store, not Play;
- a **browser extension** (Chromium + Firefox) — the "Google" store for a Chrome extension is the
  **Chrome Web Store** ([`02-chrome-web-store.md`](02-chrome-web-store.md)), **not** Google Play.

There is **no Android app** in this repo (`grep` for `build.gradle` / `AndroidManifest.xml` → none).
So there is no artifact to upload to Play.

## What a Google Play launch would require (net-new project)

A content blocker on Android is a different architecture from a desktop browser extension:
- **Mobile-browser content blocking on Android is constrained.** Chrome for Android does **not** support
  extensions. The realistic paths are:
  1. **Firefox for Android (GeckoView)** — supports a subset of MV3 extensions. The *same* AMO listing
     ([`03-firefox-amo.md`](03-firefox-amo.md)) can be made **Android-compatible** by testing under
     Firefox for Android and adding the `gecko_android` settings — this reaches Android users **without
     Google Play** (they install from AMO inside Firefox for Android).
  2. **A standalone Android app** with its own in-app WebView/content-filtering or a system-level VPN/DNS
     filter — a large, separate engineering effort, with its own Play Console account ($25 one-time),
     Data Safety form, and review.
- **Play billing** would be Google Play Billing (separate from RevenueCat's Apple/Web Billing), which
  RevenueCat also supports — but only once a native Android app exists.

## Current release boundary — September 14, 2026

Still 2.0.0 has no Android support or Play submission. The options below are future research,
not approved work. No purchase, billing-provider setup or Android compatibility change is needed
for this free release. Recheck platform/provider requirements before planning a future implementation.

## Future options

- **If separately approved:** evaluate Firefox for Android through AMO. Verify compatibility,
  privacy, UI and actual device behavior before enabling or advertising it. The current AMO listing
  remains desktop-only; see [`03-firefox-amo.md`](03-firefox-amo.md).
- **Later (if validated):** scope a dedicated Android app as its own project, then add a Google Play
  integration only if a separately approved future commercial model requires it. Preserve supported-surface boundaries.

Google Play Console (for when there's an app): [play.google.com/console](https://play.google.com/console)
· $25 one-time registration · requires the Data Safety form and a privacy policy URL.
