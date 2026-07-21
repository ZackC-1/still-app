# Launch progress — July 13, 2026 (updated July 21)

This is the operational handoff for the English launch. Apple is configured for the United States,
Canada, and the United Kingdom. Chrome version 1.0.1 is publicly installable in the United States
and Canada. Resume here before changing a pending store submission. The canonical positioning and
paste-ready copy remain in
[`marketing-playbook.md`](marketing-playbook.md) and [`store-listing-copy.md`](store-listing-copy.md).

## 2026-07-21 — Launch state (CURRENT; supersedes the July 13–14 snapshot below)

The July 13–14 "1.0(3) coordinated launch" plan below was overtaken by the App Store rejection cycle
(2.3.2 → 2.1(a) → 5.1.1(v)) that moved Apple to **1.0 build 5**. Current live truth:

| Surface | State (2026-07-21) |
|---|---|
| **iOS 1.0 (5)** | ✅ **LIVE** — `READY_FOR_SALE` (released manually) |
| **Still Pro IAP `still_sync`** | ✅ Approved |
| **Chrome** | ✅ **LIVE** — 1.0.1 public; **1.0.3 update submitted for review** |
| **Firefox (AMO)** | ✅ **LIVE at 1.0.3** — slug `still-free-yourself`, status public |
| **macOS 1.0 (5)** | ⏳ **REJECTED / UNRESOLVED_ISSUES** — 5.1.1(v); fix sent, awaiting re-review |
| **Website source (`main`)** | ✅ Updated (PR #122, `0fec5d1`) |
| **Website LIVE** | ⚠️ **NOT yet published** — see the Pages gap below |

**macOS 5.1.1(v) account deletion.** Discoverability finding, not missing code — in-app account
deletion IS in build 5 (`App.svelte` "Delete account" → confirm → `delete-user`), but it is
signed-in-only and the reviewer (no-sign-in purchase flow) never reached it. Resolution = **reply +
Mac screen recording of the delete flow, no rebuild** (Apple's offered remedy); sent to the macOS
Resolution Center. A reply does not flip the API state to IN_REVIEW — macOS stays REJECTED until a
reviewer re-engages (~1–3 days).

**⚠️ GitHub Pages publishing gap (IMPORTANT).** The live site is served from the **`gh-pages` branch**
(`source: gh-pages`, path `/`), **published manually** — there is no CI that syncs `docs/` → `gh-pages`.
`gh-pages` was last published **2026-07-13** and is stale: its `index.html` still shows the old
Chrome-only CTA and it never received the four discovery guides. **Merging website changes to
`main`/`docs/` does NOT make them live.** To publish, the updated `docs/` content (new homepage +
launch video + `#get-still` hub + guide pages) must be copied into `gh-pages` and pushed, **preserving
the hand-maintained items that live only on `gh-pages`**: `terms.html` + `terms/`, and the
`privacy/` `support/` clean-URL directories + `.html` redirect stubs.

**Browser 1.0.3 REBUILT from `main` on 2026-07-21** — the July-14 "staged 1.0.3" zips in the table
further below are **superseded** (they predated PR #112's shared-UI changes that the extension
bundles). Fresh, Pro-enabled, clean-room-verified artifacts (Firefox rebuild byte-identical to the
uploaded binary):

| Purpose | Path | SHA-256 |
|---|---|---|
| Chrome 1.0.3 | `packages/ext-chromium/dist/stillext-chromium-1.0.3-chrome.zip` | `f144bc61a9dba862fa03da9817428211f65d34dc7d33ea0bfbe0e8c52517f27b` |
| Firefox 1.0.3 binary | `packages/ext-chromium/dist/stillext-chromium-1.0.3-firefox.zip` | `09cc4428070811f5ffc569cc7b43366d2f9a226d5f7ee2aed7418aedc5aa43aa` |
| AMO full source 1.0.3 | `packages/ext-chromium/dist/still-amo-sources-full-repo-1.0.3.zip` | `9dce5491717673d8b21cbfd6679821872bd1379a06c3f827d60c09614beb94d9` |

**Website change (PR #122).** Hero **launch video** (`docs/assets/still-launch.mp4`, 1.4 MB
H.264/faststart + poster; autoplay/muted/loop + accessible sound toggle) replaced the `.quiet-browser`
mockup; new **`#get-still` download hub** links the App Store (`apps.apple.com/app/id6784061138` —
covers iPhone/iPad/Mac Safari), Chrome, and Firefox; the stale "coming soon / Chrome-only" copy was
retired across the homepage + 5 guide pages. **Mac is advertised as available per an explicit owner
decision** (App Store button covers Mac via Universal Purchase and resolves for Mac the instant Apple
approves the pending build). Product-truth wording uses "every **supported** surface."

**Remaining actions (all human):**
1. **Publish the website to `gh-pages`** (see the Pages gap above) — this is what makes the new site live.
2. **macOS** — click **Release This Version** when Apple approves (manual release, like iOS).
3. **Chrome** — confirm 1.0.3 is set to auto-publish on approval.
4. **After macOS approval only** — rotate/unset `REVIEW_SIGNIN_CODE` + clear `VITE_REVIEW_SIGNIN_EMAIL`
   from `.env` (the macOS review still relies on that code — never rotate mid-review); optional: re-add
   the v3 IAP promo image + fix the "andTikTok" spacing typo in the App Store promotional text.
5. **Recommended, never done** — on-device mobile-blocking validation on a physical iPhone (Safari) and
   Firefox for Android ([`06-mobile-blocking-validation.md`](06-mobile-blocking-validation.md)); the
   free-tier core promise CI cannot cover.

---

## Repository checkpoint

- Remote and local `main` were synchronized at merge commit `663a898` after PR #92 recorded the
  corrected Firefox 1.0.2 submission.
- July 14: the architecture PRs #97–#109 merged to `main` (session-protocol registry, extension
  entry factory, hide-CSS seam removal, engine page session, two Apple/Safari race fixes). A full
  release validation of the merged `main` (`da6922a`) passed every automated gate on every surface:
  workspace gate, 16 Playwright fixtures, StillKit Swift tests, Supabase Deno checks, iOS + macOS
  Release compiles, `web-ext lint` (0 errors), and a byte-identical clean-room AMO rebuild.
- **Decision (July 14): pending store reviews ride unchanged.** Do not upload new packages while
  AMO 1.0.2 and Apple 1.0 (3) are in review. The merged architecture work ships as **1.0.3**
  (browser stores) and **Apple 1.0.3 build 4** immediately after the current submissions are
  approved and released. The version bumps are staged on `main`; verified 1.0.3 artifacts and
  hashes are recorded below.
- Browser package version on `main`: `1.0.3` (manifest versions: Chrome/Firefox/Safari all 1.0.3;
  Apple marketing version 1.0.3, build 4). If Apple instead **rejects** 1.0 (3), resubmit the fixed
  1.0 train by setting `MARKETING_VERSION` back to 1.0 (keep build 4) before archiving.
- PR #89 added and deployed the Chrome Web Store Limited Use privacy disclosure.
- PR #90 made the AMO launch desktop-only by omitting `gecko_android`, added a manifest contract test,
  and aligned the release documentation.
- All three protected CI checks passed for both PRs.

## Chrome Web Store

Status: **version 1.0.1 published** (verified July 14, 2026).

Completed in the live listing:

- `1.0.1` package accepted by Chrome.
- Canonical name, summary, detailed description, five screenshots, small promo tile, and marquee tile.
- Privacy purpose, permission justifications, remote-code declaration, data disclosures, and
  certifications.
- Public distribution currently limited to the United States and Canada.
- Reviewer test instructions for free Shorts blocking and optional Pro sign-in/checkout.

The public install URL is
<https://chromewebstore.google.com/detail/still-block-shorts-reels/midpefhbieafmeboompbboemeahjjnkf>.
The linked privacy policy is live at <https://zackc-1.github.io/still-app/privacy/>. Keep the current
listing stable while its first users arrive; make only deliberate metadata or availability changes.

## Firefox AMO

Current portal state (updated July 14, 2026):

- Corrected `1.0.2`: **Awaiting Review** and shown by AMO as the listed version.
- The verified full-monorepo source archive is attached to `1.0.2`, together with release notes,
  reviewer build instructions, warning explanations, and desktop-only testing instructions.
- Firefox desktop is selected and Firefox for Android is unchecked. The public product page now uses
  the canonical name, outcome-first copy, paid-upgrade disclosure, support/homepage links, branded
  icon, and the store-ready Firefox screenshot.
- `1.0.1` was used only to inspect validation and was never submitted. `1.0.2` superseded the earlier
  pending `1.0.0`; do not delete the add-on.

### Final local artifacts

Generated ZIP files are ignored by Git. They currently exist on this Mac but are not stored in the
repository history.

| Purpose | Path | SHA-256 |
|---|---|---|
| AMO full source upload (submitted 1.0.2) | `packages/ext-chromium/dist/still-amo-sources-full-repo-1.0.2.zip` | `c65909fee73444dad1cbf0edaa517d821614de52cf9778f0f73c8a3e25a3190f` |
| Staged 1.0.3 Chrome upload | `packages/ext-chromium/dist/stillext-chromium-1.0.3-chrome.zip` | `3deefe77c11de7bbb9f4df0356573c15b13e3f58bb5fa78871f5c616c69700b3` |
| Staged 1.0.3 AMO binary upload | `packages/ext-chromium/dist/stillext-chromium-1.0.3-firefox.zip` | `946b45f6410282d1ad7aa29f6e0eba7b39a41a2fca6eaf5cd96330b69b90ae94` |
| Staged 1.0.3 AMO full source upload | `packages/ext-chromium/dist/still-amo-sources-full-repo-1.0.3.zip` | `d013a4f76bb7e50e6cf844bf864b963b725d673cec423a79995a6e99e673ebfd` |

⚠️ The July 13 local copy of the **submitted** `stillext-chromium-1.0.2-firefox.zip`
(`e9e8241d…b091`) was overwritten on July 14 by a validation rebuild from post-architecture `main`
under the same filename, and was then superseded by the 1.0.3 zips above. AMO retains the canonical
submitted binary; the hash-verified 1.0.2 source archive above reproduces its `dist/firefox-mv3`
contents exactly (rebuild from commit `663a898` or the archive itself).

Each full-source archive contains the root lockfile/workspace files and only the two public extension
build variables in `packages/ext-chromium/.env`. For both 1.0.2 and staged 1.0.3, a clean extraction
was installed and rebuilt, and its `dist/firefox-mv3` output matched the corresponding binary zip
exactly (the 1.0.3 check extracted both zips and diffed rebuild against binary, byte for byte).

### Submitted AMO package

AMO accepted the binary with `0 errors` and `3 warnings`. Firefox desktop was selected and Firefox
for Android was unchecked. The warnings were documented for reviewers:

1. Svelte emits a static template `innerHTML` assignment.
2. WXT/Vite emits a bundler-controlled dynamic import.
3. AMO validates the desktop `strict_min_version: 140` against Android's data-consent floor of 142
   even though `gecko_android` is omitted and Android is unchecked. Mozilla's compatibility rules
   treat the omitted key as desktop-only.

The attached reviewer build instructions are:

   ```text
   Source: full monorepo (public: github.com/ZackC-1/still-app).
   Build (Node 20+, pnpm):
     pnpm install --frozen-lockfile
     pnpm --filter @still/ext-chromium build:firefox
   Output: packages/ext-chromium/dist/firefox-mv3
   Bundler: WXT 0.20 + Vite; minification only, no obfuscation.
   The included packages/ext-chromium/.env contains only the public Supabase URL and anon key used
   for the submitted build.
   ```

Neither generated-code warning consumes user-provided code, downloads executable code, or executes
remote code. While review is pending, do not upload another version unless Mozilla requests a change.

### Rebuild if the ignored artifacts are lost

From synchronized `main`, with `packages/ext-chromium/.env` containing the public production
Supabase URL and anon key:

```bash
pnpm install --frozen-lockfile
pnpm --filter @still/ext-chromium typecheck
pnpm --filter @still/ext-chromium test
pnpm --filter @still/ext-chromium zip:firefox
```

The WXT command recreates the binary but not the required full-monorepo source archive. Follow
[`03-firefox-amo.md`](03-firefox-amo.md) §3 to recreate and clean-room verify that archive.

## Apple App Store

Current portal state (updated July 14, 2026):

- iOS 1.0 build 3: **Waiting for Review**.
- macOS 1.0 build 3: **Waiting for Review**.
- `still_sync` / Still Pro non-consumable: **Waiting for Review** at a U.S. base price of $1.99;
  Canadian and United Kingdom equivalents were checked in App Store Connect.
- Both platform versions are set to **Manually release this version**. Do not release either version
  immediately after approval; run the coordinated launch check first.
- App and IAP availability are limited to the United States, Canada, and the United Kingdom.
- Shared identity is `Still: Block Shorts & Reels`, subtitle `Keep your attention in Safari`, primary
  category Productivity, and secondary category Utilities.
- iOS and macOS promotional text, descriptions, keywords, support URLs, marketing URLs, and App
  Review instructions use the outcome-first copy and explicitly disclose that mobile support means
  websites opened in Safari, not native social-video apps.
- App Privacy declares Email Address, User ID, Purchase History, and Other Data Types (synced
  settings), all for App Functionality, linked to identity, and not used for tracking.
- Accessibility Nutrition Labels remain unclaimed. Apple will not publish them before a platform
  version is released, and each label requires hands-on testing on iPhone, iPad, and Mac after launch.
- App Store Tags are not currently offered for this app record. No edit control is available; recheck
  after approval because Apple derives eligible U.S. tags from the app's English (U.S.) metadata.
- Existing submitted screenshots remain in place. Do not upload the prepared service-logo marketing
  screenshots until the documented third-party-rights risk is resolved or neutral accurate assets
  replace them.

Before treating Apple metadata as fully closed, visually confirm that the Still Pro page saved the
public description `Block Reels and TikTok, and sync across devices.`, the brand-safe 1024-square
promotional image, and the detailed reviewer notes. The private Review Information screenshot should
remain the real in-app paywall.

## Website

- The cross-store marketing site, support page, privacy page, terms, sitemap, robots file, and Open
  Graph image are deployed on GitHub Pages.
- The Chrome Web Store link is live on the homepage. Add direct Apple and Firefox store links only
  after those listings are publicly available.
- The source now includes four organic discovery guides and their sitemap entries. Publish those
  source changes with the next GitHub Pages update; each guide links only to the live Chrome listing
  and routes Safari/Firefox visitors to Support until those listings are public.
- The approved web-purchase refund window is **5 days**. The Support page already says five days;
  the matching Terms source is prepared in the `gh-pages` worktree and must ship in the same Pages
  update so the public pages remain aligned.

## Coordinated approval and release gate

When a store status changes, do not immediately alter another pending submission. Record the new
status, then check:

1. iOS and macOS are both approved and still held for manual release.
2. Still Pro is approved and attached to the launch version.
3. Public listing links, privacy, support, purchase, restore, and same-email entitlement restore work.
4. Chrome is public in the United States and Canada. Add the United Kingdom to its distribution before
   announcing UK-wide cross-platform availability; wait for Firefox's review outcome before linking it.
5. The homepage exposes only live store links and repeats the Safari-only/native-app limitation.
6. Release iOS and macOS together, then run the post-release accessibility evaluation separately on
   iPhone, iPad, and Mac.
7. After the launch versions are live, upload the staged 1.0.3 packages (hashes above) to Chrome and
   AMO, and archive/upload Apple 1.0.3 build 4 from `main`. Rerun the on-device checks in
   [`06-mobile-blocking-validation.md`](06-mobile-blocking-validation.md) and the `VALIDATION.md`
   manual cross-surface passes against build 4 before releasing it.

## Safe resume check

```bash
cd /Users/zack/Projects/still-app
git switch main
git pull --ff-only origin main
git status --short --branch
node -p "require('./packages/ext-chromium/package.json').version"
shasum -a 256 \
  packages/ext-chromium/dist/stillext-chromium-1.0.3-chrome.zip \
  packages/ext-chromium/dist/stillext-chromium-1.0.3-firefox.zip \
  packages/ext-chromium/dist/still-amo-sources-full-repo-1.0.3.zip
```

Expected: clean `main`, version `1.0.3`, and the three staged-1.0.3 hashes recorded above.
