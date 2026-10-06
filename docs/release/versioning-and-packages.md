# Versioning and reproducible packages

One file, `version.json` at the repository root, decides what version Still ships. Nothing here talks
to a store; it only prepares local files for the owner's separately authorized submissions.

| Key | Feeds |
|---|---|
| `extension` | Chrome and Firefox manifest version (through `packages/ext-chromium/package.json`, which WXT reads) |
| `apple` | Apple app `MARKETING_VERSION` (every Xcode target) and the Safari extension version (`packages/ext-safari/package.json`) |
| `appleBuild` | Apple `CURRENT_PROJECT_VERSION` (every Xcode target) |

`extension` and `apple` are separate because the stores move independently (for example Chrome and
Firefox 2.1.1 with Apple 2.1.0). Set them equal when a release ships everywhere together.

## Changing a version

```bash
node scripts/release/version.mjs set extension 2.2.0    # refuses to go backwards, then syncs
node scripts/release/version.mjs set apple 2.2.0
node scripts/release/version.mjs bump-build             # appleBuild + 1, then syncs
node scripts/release/version.mjs check                  # exits 1 if any consumer disagrees
node scripts/release/version.mjs sync                   # rewrite consumers from version.json
```

`appleBuild` only ever goes up and is never reset when `apple` changes. A test reads every committed
revision of `version.json` and fails if the number ever fell. Every App Store Connect upload needs a
build number higher than anything already uploaded for the app, so bump it before each archive, even
for a rebuild of the same marketing version.

## Building the packages

```bash
node scripts/release/package.mjs --out /tmp/still-release \
  --env VITE_SUPABASE_URL=... --env VITE_SUPABASE_ANON_KEY=... \
  --env VITE_POSTHOG_KEY=... --env VITE_POSTHOG_HOST=... \
  --env VITE_MODERN_SETTINGS_SYNC_ENABLED=...   # only if the release sets it; copy the value from the submitted build
```

The script always builds fresh, from `git archive HEAD` exported into a temporary directory (it installs
with the frozen lockfile there). It never zips your working tree or an existing `dist/`, so an untracked
file, an ignored `.env`, a symlink or a stale `dist/` cannot reach a package. It refuses uncommitted edits to
tracked files, because a HEAD build would silently ignore them.

It writes `still-chrome-<v>.zip`, `still-firefox-<v>.zip`, `still-source-<v>.zip` (the complete source AMO
requires, read from the committed tree, with `AMO-BUILD-INSTRUCTIONS.md`) and `SHA256SUMS.json` /
`SHA256SUMS.txt`. Only the listed public build values are accepted; every other `VITE_*` variable in your
shell is removed (`WXT_*` too). A tracked symlink is refused before anything is built, and every output is held
back until all checks pass, so a failed run never leaves zips in `--out`. If shipped source starts reading a `VITE_*` or `WXT_*` name that is on neither the public list nor
the deliberately-unpackaged list (`PUBLIC_ENV_KEYS`, `DELIBERATELY_UNPACKAGED` in `package.mjs`), the build
stops until someone decides which list it belongs on. The scan reads ts, tsx, mts, cts, js, jsx, mjs, cjs,
svelte and html (including `%VITE_X%` placeholders) but sees only names written out literally; a name built
at runtime, such as `import.meta.env[prefix + "KEY"]`, is invisible to it, so do not write code that way. Record the hashes with the submission. Use this
instead of `wxt zip`, whose archives carry timestamps and change on every run.

Archives have sorted entries, a fixed 1980-01-01 timestamp, fixed permissions, no symlinks and no machine
paths, so the same commit built twice with the same Node version gives byte-identical files. A different
Node version can compress differently while the files inside stay identical; compare extracted contents then.
Run `pnpm test:release` to prove all of this (it builds twice, with files planted in the checkout). It needs
full git history: it fails on a shallow clone, and CI checks out with `fetch-depth: 0`.

Built bundles are also independent of the checkout folder. The Chromium, Safari and Apple web-view builds
all set a Svelte `cssHash` that hashes only the CSS text (see the comment in each Vite/WXT config), so the
scoped class names (`svelte-xxxxxxx`) do not change with the path. To check: build the same commit in two
different folders with the same `VITE_*` values and run `diff -r` on the two `dist` folders (for Safari,
`packages/ext-safari/dist`; for the Apple web view, `packages/app-webview/dist`); it must print nothing.
