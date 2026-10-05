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
node scripts/release/package.mjs --out /tmp/still-release --build \
  --env VITE_SUPABASE_URL=... --env VITE_SUPABASE_ANON_KEY=... \
  --env VITE_POSTHOG_KEY=... --env VITE_POSTHOG_HOST=...
```

This writes `still-chrome-<v>.zip`, `still-firefox-<v>.zip`, `still-source-<v>.zip` (the complete
source AMO requires, read from the committed tree, with `AMO-BUILD-INSTRUCTIONS.md`) and
`SHA256SUMS.json` / `SHA256SUMS.txt`. Only the four public build values are accepted; every other
`VITE_*` variable in your shell is removed, and the script refuses to run with a `.env` file in
`packages/ext-chromium`. Record the hashes with the submission. Use this instead of `wxt zip`, whose
archives carry timestamps and change on every run.

Archives have sorted entries, a fixed 1980-01-01 timestamp, fixed permissions and no machine paths, so
the same commit built twice with the same Node version gives byte-identical files. A different Node
version can compress differently while the files inside stay identical; compare extracted contents then.
Run `pnpm test:release` to prove all of this (it builds twice).
