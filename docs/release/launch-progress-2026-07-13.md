# Launch progress — July 13, 2026 (updated July 14)

This is the operational handoff for the English launch. Apple is configured for the United States,
Canada, and the United Kingdom. Chrome version 1.0.1 is publicly installable in the United States
and Canada. Resume here before changing a pending store submission. The canonical positioning and
paste-ready copy remain in
[`marketing-playbook.md`](marketing-playbook.md) and [`store-listing-copy.md`](store-listing-copy.md).

## Repository checkpoint

- Remote and local `main` were synchronized at merge commit `663a898` after PR #92 recorded the
  corrected Firefox 1.0.2 submission.
- Browser package version on `main`: `1.0.2`.
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
| AMO binary upload | `packages/ext-chromium/dist/stillext-chromium-1.0.2-firefox.zip` | `e9e8241d681e0d64b6fd46920e1a3bf5ca116e53197ffb5ae45c136bb17db091` |
| AMO full source upload | `packages/ext-chromium/dist/still-amo-sources-full-repo-1.0.2.zip` | `c65909fee73444dad1cbf0edaa517d821614de52cf9778f0f73c8a3e25a3190f` |

The full-source archive contains the root lockfile/workspace files and only the two public extension
build variables in `packages/ext-chromium/.env`. A clean extraction was installed and rebuilt, and its
`dist/firefox-mv3` output matched the binary upload directory exactly.

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

## Safe resume check

```bash
cd /Users/zack/Projects/still-app
git switch main
git pull --ff-only origin main
git status --short --branch
node -p "require('./packages/ext-chromium/package.json').version"
shasum -a 256 \
  packages/ext-chromium/dist/stillext-chromium-1.0.2-firefox.zip \
  packages/ext-chromium/dist/still-amo-sources-full-repo-1.0.2.zip
```

Expected: clean `main`, version `1.0.2`, and the two hashes recorded above.
