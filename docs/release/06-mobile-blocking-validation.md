# Track 6 — Mobile short-form blocking: Safari launch gate + future Firefox Android

Removing **YouTube Shorts is the free-tier core promise**, and mobile is historically Still's
**weakest surface** — the one place CI can't reach. The required launch gate covers iPhone Safari,
the only mobile surface advertised at launch. Firefox Android is a future validation track and does
not block the desktop-only AMO submission.

> **Why this can't be skipped.** Every automated test (Playwright fixtures, engine/redirect units)
> runs in **headless Chromium against synthetic mobile-DOM fixtures**. That proves the selectors and
> redirect logic are correct, but it cannot exercise a real iOS Safari runtime, where the launch's
> load-bearing mobile risk lives (a `document_start` content script running late on a direct Short
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
| A physical **Android** device (or emulator) with **Firefox for Android** | Future Firefox-Android validation only |
| The build enabled on-device | iOS: the app's Safari extension enabled in Settings; future Firefox: the add-on installed |

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
  current `ytm-*` selector in the seed, re-sign it, regenerate the packaged CSS, and ship it in an app
  release. **A selector fix cannot reach Safari over the air today**: the Safari build carries no
  backend address, so it never fetches a hosted rule set, and the hosted set is older than the bundled
  one, so no client would apply it even if it did. Treat the bundled seed as the only path to a device
  until a newer signed set is published and the Safari build is given the endpoint.
- If the **redirect** doesn't fire on a direct nav: confirm the content script runs at `document_start`
  on that page; the pre-hydration redirect is already wired for Safari (`redirectBeforeHydration`).

---

## B. Firefox for Android — future compatibility gate (not required for launch)

Firefox has **no DNR redirect**, so PR #36 wired `redirectBeforeHydration` on the Firefox build — this
validates that fix on a real device. Complete this section before adding `gecko_android` to a future
manifest; the launch AMO build deliberately omits that key and is desktop-only.

1. [ ] Install the add-on on Firefox for Android (from AMO once listed, or a temporary install for a
       pre-submit smoke test).
2. [ ] **Redirect, direct nav.** Open `m.youtube.com/shorts/<id>` cold. **Expect:** lands on
       `/watch?v=<id>`, the Short doesn't play.
3. [ ] **Shelf + nav removed** on the m.youtube.com home feed (same as iOS steps 3–4).
4. [ ] **Off/paused honored** (same as iOS step 6).

> Firefox-Android is not advertised or distributed at launch. Once introduced, validate it on every
> release that changes blocking, authentication, or extension UI behavior.

---

## D. iPhone timing pass: is Still costing the page anything?

Automated tests cannot answer this. Playwright cannot load a Safari extension, and the emulated
WebKit numbers come from a Mac, so the only real iPhone figures are the ones a person reads off a
device. Run this whenever the content script, the observer or the YouTube rule set changes.

Two runs of the same three pages, one with the Still extension off and one with it on, so the
comparison is like for like. Toggle Still in **Settings, Apps, Safari, Extensions, Still**; leave
everything else alone between runs, including the Wi-Fi network.

Pages, in this order each time:

1. `m.youtube.com`
2. `m.youtube.com/results?search_query=news`
3. `m.youtube.com/watch?v=aqz-KE-bpKQ`

For each page, three times:

1. [ ] Close every Safari tab, then open a new one.
2. [ ] Type the address and start a stopwatch as you tap Go.
3. [ ] Stop it when the page has stopped moving and the first row of thumbnails is readable.
4. [ ] Scroll steadily through about ten screens with one finger and note whether the scroll ever
       stutters, and if so where.

Record the middle of the three times per page per state, and the stutter note. Nine numbers with the
extension off, nine with it on. What matters is the difference between the two states on the same
page, not the absolute value.

If the "on" numbers are more than about a second worse than "off" on any page, or scrolling stutters
with Still on and not with it off, that is a real regression and worth a Web Inspector session:
tether the iPhone to a Mac, open **Develop, your iPhone, the page**, and use the Timelines tab to see
where the main thread is going.

For a precise figure rather than a stopwatch, with the iPhone tethered and Web Inspector open, paste
this into the console on the loaded page and read the two numbers:

```js
const nav = performance.getEntriesByType("navigation")[0];
const paint = performance.getEntriesByType("paint").find((p) => p.name === "first-contentful-paint");
console.log("first paint ms", Math.round(paint?.startTime ?? 0), "load ms", Math.round(nav.loadEventEnd));
```

Safari implements neither the Long Tasks API nor Total Blocking Time, so there is no equivalent
one-liner for main-thread blocking on a device. Judge that by whether scrolling stutters.

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
- [ ] Before a future Android-compatible AMO build: Firefox Android `m.youtube.com` redirect + removal
      verified on a real device.
- [ ] Pro mobile surfaces (IG/FB/TikTok) verified for an entitled user; free user sees only YouTube gone.
- [ ] Any selector drift found was fixed in the bundled seed, re-signed, and re-tested in a new build.
- [ ] The timing pass in section D was run and its numbers recorded.

> Record the results honestly in the submission notes. If mobile YouTube blocking is not solid on iOS
> Safari, that is a **launch-quality issue for the free tier**, not a cosmetic one — fix or explicitly
> descope (as #28 originally did for v1) before submitting.

## July 9, 2026 PT iOS functional test notes

- iOS app is installed on a physical iPhone and the user reports YouTube blocking is working effectively.
- Entitled test account shows `Synced across your devices`.
- Instagram mobile Reels are removed; toggling Still on/off makes Reels reappear/disappear as expected.
- TikTok mobile is blocked effectively.
- Facebook mobile Reels route (`m.facebook.com/watch/reels/`) is blocked, but the Reels icon remains
  visible from the Facebook home screen. Treat as likely mobile selector drift until inspected with
  Safari Web Inspector.
- Safari Web Inspector showed the missed Facebook icon renders as
  `[role="tab"][aria-label="reels, 4 of 6"]`. Added
  `[role="tab"][aria-label*="reels" i]` to the Facebook Reels hide selectors, bumped the bundled
  rule-set seed to `1.0.1`, re-signed the dev seed, regenerated Safari/Chromium Pro CSS, and added a
  regression test. Local verification passed; device retest is pending after reinstall or hosted
  production rule-set publish.
- First retest still showed the Facebook home Reels icon because Xcode copies
  `packages/ext-safari/dist/safari-mv3`, and only the entrypoint CSS had been regenerated. Rebuilt
  `@still/ext-safari`; the built `content-scripts/content.css` now contains
  `[role=tab][aria-label*=reels i]`. Updated the Apple Xcode copy phases and
  `apps/apple/scripts/build.sh` so Safari extension assets are rebuilt before Xcode copies them.
  Verified with an unsigned iOS simulator Xcode build; physical-device reinstall/retest is pending.
- Xcode GUI device run initially failed in the Safari extension script phase after adding the rebuild
  step because GUI-launched Xcode did not inherit Homebrew's `pnpm` path. Added an explicit
  `/opt/homebrew/bin:/usr/local/bin` PATH and actionable `pnpm not found` error to the Xcode phases;
  unsigned iOS simulator build passes after the fix.
- Follow-up retest showed the Facebook Reels route/content is blocked, but the visual result can leave
  a large gray square. Web Inspector showed the Reels tab is a child of `[role="tablist"]`; earlier
  inspection also showed mobile Reel tiles can render as `[role="button"][aria-label*="reel video"]`
  without a `/reel/` link. Added a direct tablist-child hide selector and a button-only reel-video
  remove selector, re-signed the seed, rebuilt Safari dist, and verified targeted tests.
- Clean reinstall still left a gray tablist slot, confirming CSS `display:none` was hiding the Reels
  tab content while Facebook kept a six-slot tablist layout. Moved the mobile Reels tab selector from
  a CSS hide surface to a JS remove surface (`fb-mobile-tabs`) so the tab node is removed from the DOM.
  Rebuilt Safari dist; packaged CSS no longer contains the mobile role-tab selector, while the bundled
  JS rule set does. Device retest pending.
- Screenshot retest still showed the gray slot. Root cause is likely rule-set precedence: hosted/cached
  production rules are already version `1.0.1`, and the bundled debug seed was also `1.0.1`; the loader
  prefers cached rules on version ties. Bumped the bundled seed to `1.0.2`, re-signed, rebuilt Safari
  dist, and verified the built content script embeds `version: 1.0.2` plus `fb-mobile-tabs`.
- After another clean reinstall, the gray Facebook tab slot still remained while Reels viewing stayed
  blocked. Filed follow-up bug: https://github.com/ZackC-1/still-app/issues/58. Do not block the
  release test pass on this cosmetic Facebook mobile residue; functional blocking is effective.
