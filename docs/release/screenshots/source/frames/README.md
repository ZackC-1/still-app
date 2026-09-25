# Showcase screenshots: how they were chosen and how to remake them

The store images in [`../../store-ready/`](../../store-ready/README.md) are made here: real captures
of Still, framed with a headline, the service's logo and red marker marks. This guide records the
choices behind the 2.1 set (September 2026) and the exact steps to redo any image.

## What the images must say

- **The story:** short-form video is built to pull attention. The "before" shots show real
  attention bait on each site; the "after" shots show the same site with it gone. The copy stays
  calm; the content carries the temptation.
- **Accuracy:** every picture is a real capture of the current build. The red marks land only on
  elements Still's rule set removes (`annotate.js` reads the selectors from
  `packages/core/rules/seed.json`), and only on "before" shots. There is one X per picture or
  section header, a loop around small entry points (a tab or chip), and never one X across
  several pictures.
- **Store safety:** Apple wants screenshots suitable for every age, and Chrome and Firefox ban
  suggestive listing images. Money hooks, supercars, luxury and mainstream glamour are fine. Innuendo
  in a Reel's caption is acceptable (owner decision). Reject anything involving minors, nudity or
  sexualised poses, drugs, violence or politics, and any private person's name.
- **No ads, no personal data:** the Facebook shots avoid ads on either side. Signed-in pages never
  show the account's name, friends or groups.
- **Logos:** each image names its service with that service's logo (sources in `logos/README.md`).

## The content chosen for 2.1

| Service | "Before" | "After" | Why |
|---|---|---|---|
| YouTube, desktop | Search "passive income": Shorts shelf ("30 Passive Income Ideas") | Same search, Shorts gone | Money bait; the search page is stable, so both halves match |
| YouTube, iPhone | Search "side hustle": four Shorts ("$100 A DAY", "$1,500 in 30 minutes") | Same search, regular videos only | The mobile "passive income" page showed no Shorts shelf |
| TikTok | `#passiveincome` hashtag page | Still's "This site is blocked" | Get-rich hooks; the For You feed is random and shows private people |
| Instagram | Supercar Blondie's Reels grid (160M, 135M views) | The same profile: posts stay, Reels tab gone | Luxury cars from a public creator; the home feed was random |
| Facebook | The signed-in home feed's Reels shelf | A later spot in the same feed with no shelf (a Formula 1 post) | Shows Still removing Reels from the feed itself |

**Candidates rejected:**
- YouTube "millionaire day in my life": its Shorts featured 13- and 17-year-olds.
- YouTube "lamborghini": one title could refer to a child.
- TikTok's For You feed: random videos of private people.
- Grant Cardone's Facebook Reels: political news.
- Tasty's Facebook Reels: a toddler.
- Early Facebook feed loads: ads, or captions with profanity.

**Time of day:** phone Safari shots use a **1:47 AM** status bar, so the "before" reads as
late-night scrolling. App and setup screens keep 9:41.

## Where each image comes from

`sources.json` lists every page a capture uses. Override one for a single run with
`SOURCE_<KEY>`, e.g. `SOURCE_TIKTOK=https://www.tiktok.com/tag/supercars`. `frames.json` describes
each image: its canvas (store size), layout, headline, captures and crops. `render-frames.mjs`
draws them, and `tests/playwright/showcase-frames.spec.ts` checks sizes and forbidden claims.

| Script | Captures |
|---|---|
| `capture.mjs [youtube tiktok instagram instagram-profile facebook facebook-reels ui]` | Desktop pages in Playwright Chromium with the release Chrome build: each page without Still (marked) and with Still |
| `capture.mjs --login` | Opens the signed-in capture profile (`~/.still-capture/chromium`, outside the repo) so the owner can sign in to Instagram and Facebook |
| `capture-firefox.mjs [youtube tiktok]` | The same pages in Firefox with the release Firefox build as a temporary add-on |
| `capture-chrome-window.mjs` / `capture-firefox-window.mjs` | Still's popup open in a real browser window |
| `build-bookmarklet.mjs` | "Still before"/"Still after" bookmarklets that mark pages in Safari (Simulator or Mac) |

## Remaking the images

1. Build the candidate with analytics pointed nowhere, so captures send no usage data:
   `VITE_POSTHOG_HOST=http://127.0.0.1:9 pnpm build` (copy the public `.env` files into
   `packages/*/` first, so sign-in shows as it does in the store build).
2. **Desktop:** `node docs/release/screenshots/source/frames/capture.mjs youtube tiktok instagram-profile`
   and `capture-firefox.mjs youtube tiktok`. Review every capture before using it.
3. **Facebook feed** (signed in):
   - Run `REDACT="First Last,Last,First" FEED_AFTER_HEIGHT=3200 node .../capture.mjs facebook`.
   - `REDACT` covers the account's own name on the page. It is passed at run time only and never stored.
   - The "after" is taken on a taller window, so crop it (in `frames.json`) to an ordinary post,
     not an ad.
   - The feed is random: run it several times and keep the best pair.
   - Crop to the feed column only (x 312–968 CSS px), which leaves out the profile, groups and
     friend suggestions.
4. **iPhone and iPad:**
   - Build the Debug app for the Simulator, install it, and set the status bar:
     `xcrun simctl status_bar <id> override --time "1:47" …`
   - In Settings → Apps → Safari → Extensions → Still, turn Still on and set all four sites to Allow.
   - Open pages with `xcrun simctl openurl`. When Simulator Safari stalls on a blank page, quit it
     and delete `data/Library/Safari/SafariTabs.db*` before retrying.
   - Turn Still off and on from Safari's page menu (the "Still" item) for before/after pairs.
   - Marks on Safari captures are drawn by the compositor from measured positions
     (`crop.marks` in `frames.json`).
   - YouTube never loads in the iPad Simulator, so the iPad set has no YouTube image.
5. **Mac app window:** build the macOS app unsigned, remove its Safari extension, ad-hoc sign it,
   back up `~/Library/Preferences/group.com.chartash.still.plist`, capture the window by its ID,
   then restore the file.
6. Render and check:
   - `node docs/release/screenshots/source/frames/render-frames.mjs [store or id]`
   - `pnpm exec playwright test --project=fixtures tests/playwright/showcase-frames.spec.ts`
   - Review `contact-sheet.html` at full and thumbnail size. Rendering one id also rewrites the
     contact sheet with just that image; run all stores before reviewing the set.

Raw signed-in captures (`captures/*/instagram*`, `captures/*/facebook*`) are gitignored. Only the
cropped store images are committed. Delete candidate captures when done.
