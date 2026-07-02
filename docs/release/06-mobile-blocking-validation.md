# Track 6 — Mobile short-form blocking: on-device validation (REQUIRED)

Removing **YouTube Shorts is the free-tier core promise**, and mobile is historically Still's
**weakest surface** — the one place CI can't reach. This checklist is the on-device gate that mobile
blocking actually works before any store submission. **Do not ship a store build without it.**

> **Why this can't be skipped.** Every automated test (Playwright fixtures, engine/redirect units)
> runs in **headless Chromium against synthetic mobile-DOM fixtures**. That proves the selectors and
> the redirect logic are correct, but it cannot exercise a real iOS Safari or Firefox-Android runtime,
> where the load-bearing risk lives (a `document_start` content script running late on a direct Short
> nav, or the mobile DOM having drifted from the seed selectors). This was GitHub issue #28.

**What the code does today** (so you know what "working" looks like):
- **Redirect (highest value, selector-free):** a direct nav to `m.youtube.com/shorts/<id>` is redirected
  to `/watch?v=<id>`. On Safari and Firefox this fires **synchronously at `document_start` before
  storage hydration** so the Short can't start playing first (Safari: always; Firefox: since PR #36 —
  Firefox has no DNR redirect, so the content script is the only redirect). Chromium desktop uses the
  network-layer DNR rule instead.
- **Removal:** the mobile Shorts shelf and the pivot-bar Shorts nav item are hidden via `ytm-*`
  selectors (including a `.pivot-shorts` class fallback for the icon-only nav item).

---

## Prerequisites

| Need | For |
|------|-----|
| A physical **iPhone** + a **Mac** with Safari | iOS Safari validation (tether for Web Inspector) |
| A physical **Android** device (or emulator) with **Firefox for Android** | Firefox-Android validation |
| The build enabled on-device | iOS: the app's Safari extension enabled in Settings; Firefox: the add-on installed |

> **Chrome Android is not a surface.** Chrome for Android does not support extensions, so there is no
> mobile-Chrome YouTube case to validate — the Chrome Web Store build is desktop-only. (Kiwi/other
> Chromium-Android browsers are out of scope.)

---

## A. iOS Safari — `m.youtube.com` (the primary mobile surface, free tier)

Run on a real iPhone with the Still app installed and its Safari extension enabled
(Settings → Apps → Safari → Extensions → Still → **On**, and **Allow** on youtube.com).

1. [ ] **Redirect, direct nav (the #28 fix).** In Safari, type or open a Shorts URL cold:
       `https://m.youtube.com/shorts/` + any known short id. **Expect:** it lands on the normal
       **`/watch?v=<id>`** player — the Short does **not** start playing first.
2. [ ] **Redirect, in-app tap.** From the m.youtube.com home feed, tap a Short. **Expect:** redirected
       to the watch page, not the Shorts player.
3. [ ] **Shelf removed.** On the m.youtube.com **home feed**, the **Shorts shelf** is gone (no
       `ytm-reel-shelf-renderer` / Shorts section), while normal video cards remain.
4. [ ] **Nav item removed.** The bottom **pivot bar** has **no Shorts tab**.
5. [ ] **Search.** Search a term that surfaces Shorts — the Shorts results/shelf are removed, normal
       results remain.
6. [ ] **Off/paused honored.** Toggle YouTube off (or pause on the site) in the app → Shorts return;
       toggle back on → gone. (Confirms the redirect respects the setting after hydration.)

**If any step fails**, diagnose with Web Inspector (this is exactly how #28 was found):
- iPhone → Settings → Safari → Advanced → **Web Inspector ON**; tether to the Mac; Mac Safari →
  **Develop → [your iPhone] → the page**.
- Confirm injection: `document.documentElement.className` should include **`still-active`** on an apply
  page. Empty on a `/shorts/` page can mean the redirect fired (good) or the script didn't inject.
- If the **shelf** isn't hidden: inspect the real element — the mobile Shorts section selector may have
  drifted from the seed (`packages/core/rules/seed.json` → `youtube` → `yt-home-shelf`). Author the
  current `ytm-*` selector, ship it via the **OTA rule-set** (no store re-review needed — see the
  signed rule-set path), and re-test.
- If the **redirect** doesn't fire on a direct nav: confirm the content script runs at `document_start`
  on that page; the pre-hydration redirect is already wired for Safari (`redirectBeforeHydration`).

---

## B. Firefox for Android — `m.youtube.com` (free tier; PR #36)

Firefox has **no DNR redirect**, so PR #36 wired `redirectBeforeHydration` on the Firefox build — this
validates that fix on a real device.

1. [ ] Install the add-on on Firefox for Android (from AMO once listed, or a temporary install for a
       pre-submit smoke test).
2. [ ] **Redirect, direct nav.** Open `m.youtube.com/shorts/<id>` cold. **Expect:** lands on
       `/watch?v=<id>`, the Short doesn't play.
3. [ ] **Shelf + nav removed** on the m.youtube.com home feed (same as iOS steps 3–4).
4. [ ] **Off/paused honored** (same as iOS step 6).

> Firefox-Android is a small surface (most mobile YouTube is the native app, which no extension can
> touch), but it's the one non-iOS mobile surface Still reaches — validate it once per release.

---

## C. Pro mobile surfaces (entitled user, all mobile)

After unlocking Still Pro on the device (iOS: IAP; Firefox: web checkout once the deploy checklist is
live), confirm the Pro mobile surfaces on the mobile hosts:

1. [ ] **`m.instagram.com`** — Reels routes blocked, mobile Reels surfaces removed, normal posts remain.
2. [ ] **`m.facebook.com`** — Reels routes blocked (`/watch/reels/`), mobile Reels sections removed.
3. [ ] **`m.tiktok.com`** — whole-site block shows the Still "This site is blocked." placeholder.
4. [ ] **Free user sees none of the above blocked** (Pro-gated) — sanity-check on a signed-out/free
       device that IG/FB/TikTok are untouched while YouTube Shorts still go.

---

## Done when

- [ ] iOS Safari `m.youtube.com`: redirect (direct + in-app), shelf, and nav all verified on a physical
      iPhone; off/paused honored.
- [ ] Firefox Android `m.youtube.com`: redirect + removal verified on a real device.
- [ ] Pro mobile surfaces (IG/FB/TikTok) verified for an entitled user; free user sees only YouTube gone.
- [ ] Any selector drift found was fixed via the OTA rule-set and re-tested (no store resubmission
      needed for rule-set-only fixes).

> Record the results honestly in the submission notes. If mobile YouTube blocking is not solid on iOS
> Safari, that is a **launch-quality issue for the free tier**, not a cosmetic one — fix or explicitly
> descope (as #28 originally did for v1) before submitting.
