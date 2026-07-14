# Launch progress — July 13, 2026

This is the operational handoff for the English U.S./Canada launch. Resume here before changing a
store submission. The canonical positioning and paste-ready copy remain in
[`marketing-playbook.md`](marketing-playbook.md) and [`store-listing-copy.md`](store-listing-copy.md).

## Repository checkpoint

- Remote and local `main` were synchronized at merge commit `e511b8e` after PR #91 recorded this
  handoff.
- Browser package version on `main`: `1.0.2`.
- PR #89 added and deployed the Chrome Web Store Limited Use privacy disclosure.
- PR #90 made the AMO launch desktop-only by omitting `gecko_android`, added a manifest contract test,
  and aligned the release documentation.
- All three protected CI checks passed for both PRs.

## Chrome Web Store

Status: **version 1.0.1 submitted for review**.

Completed in the submitted draft:

- `1.0.1` package accepted by Chrome.
- Canonical name, summary, detailed description, five screenshots, small promo tile, and marquee tile.
- Privacy purpose, permission justifications, remote-code declaration, data disclosures, and
  certifications.
- Public distribution limited to the United States and Canada.
- Reviewer test instructions for free Shorts blocking and optional Pro sign-in/checkout.

Do not edit or resubmit while review is pending unless Google requests a change; doing so can restart
review. The linked privacy policy is live at
<https://zackc-1.github.io/still-app/privacy.html>.

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

## Apple and website

- iOS and macOS apps remain in App Store review.
- The cross-store marketing site, support page, privacy page, terms, sitemap, robots file, and Open
  Graph image are deployed on GitHub Pages.
- Before uploading Apple screenshots, resolve the documented third-party service-logo rights risk in
  [`screenshots/store-ready/README.md`](screenshots/store-ready/README.md).

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
