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

## Production access trust (Still Pro verification keys)

Still Pro unlocks only when a store build can verify the server's signed access proof. The build needs the
server's **public** Ed25519 verification key for that. One committed file holds it:
`scripts/release/production-access-keys.json`.

```json
{
  "about": "…",
  "keys": [
    { "kid": "still-access-2026-10", "publicKeyHex": "<64 lowercase hex: the 32-byte public key>", "environment": "production", "purpose": "access" },
    { "kid": "still-access-standby", "publicKeyHex": "<64 hex>", "environment": "production", "purpose": "access" }
  ]
}
```

Row 1 is the key the server signs with now; row 2 (optional) is a standby. Builds trust both, so the server
can switch to the standby key without a new store version. The next release then makes the standby the
current key and adds a fresh standby.

Every store build reads that one file:

- `package.mjs` (and so the Chrome release workflow, which calls it through `chrome-package.mjs`) builds the
  Chrome and Firefox packages with `VITE_ACCESS_ENVIRONMENT=production` and
  `VITE_ACCESS_PUBLIC_KEYS=<the rows as JSON>`. These two values can never be passed with `--env`; they come
  only from the committed file at the commit being built. They are listed in `AMO-BUILD-INSTRUCTIONS.md`, and
  `SHA256SUMS.json` records `accessTrust` (environment, kids and the SHA-256 of the rows).
- `apps/apple/scripts/archive.sh` exports the same two values for the Apple web bundle and, for the archive
  only, writes the rows into the four Info.plists (`iOS (App)`, `iOS (Extension)`, `macOS (App)`,
  `macOS (Extension)`) as `StillAccessEnvironment` = `production` and `StillAccessTrustKeys`. It restores the
  plists byte for byte when it exits. With no keys pinned the plists are left unchanged. For a raw
  `xcodebuild archive`, run `node scripts/release/access-trust.mjs apple-apply --backup <empty dir>` first and
  `node scripts/release/access-trust.mjs apple-restore --backup <same dir>` afterwards, and export the output
  of `node scripts/release/access-trust.mjs env` before building the web bundle. If a run is killed before
  it restores, `git checkout -- 'apps/apple/Still/*/Info.plist'` puts the plists back (the next apply refuses
  until then).

A store build refuses:

- any row whose `environment` is not `production` (a sandbox key never reaches a store);
- any row that is not exactly `kid`, `publicKeyHex`, `environment`, `purpose` (so a private key cannot be
  added by mistake), more than two rows, or a repeated kid or key;
- the TEST-ONLY fixture key (`tests/fixtures/access-trust/TEST-ONLY-production-access-keys.json`, or any
  kid starting with `test-only`). That fixture is for tests only. Its private halves were discarded when
  it was generated, so nothing can sign for it. It is not the real key;
- an empty list once the release declares the paid tier. Today that means either paid constant is true
  (`PAID_TIER_ENABLED` in `packages/shared-types/src/entitlement.ts` or `paidTierEnabled` in StillKit's
  `MonetizationConfig.swift`, both read from the commit being built). Each declaration must appear exactly
  once, with or without a type annotation; a reworded or missing one stops the build rather than reading as
  free. The per-release-line `paidTier` that PR-B adds to `scripts/release/version.mjs` plugs into the same
  hook (`paidDeclared` in `scripts/release/access-trust.mjs`, marked `TODO(PR-B)`);
- a paid release built without the server check below passing (the release gate).

`node scripts/release/access-trust.mjs check [--server-secrets-json <file>]` runs the same checks and prints the
kids and the rows' hash.

### Putting the real key in (the release PR)

The swap is a one-file change: replace the empty `keys` list in `scripts/release/production-access-keys.json`
with the current row and the standby row. Nothing else changes.

`publicKeyHex` must be the **public** half. An Ed25519 private seed is also 32 bytes (64 hex characters), so
the file's shape check cannot tell them apart; the release gate below can, because only the real public
key matches the server's.

The owner generates each key pair **offline, on their own machine, in their own terminal** (never through an
agent, never in a file inside the repository). It needs OpenSSL 3 (`openssl version`); older LibreSSL builds
cannot make Ed25519 keys.

```bash
openssl genpkey -algorithm ed25519 -out <offline dir>/still-access-current.pem
# Public half: the 64-hex value for publicKeyHex (safe to commit).
openssl pkey -in <offline dir>/still-access-current.pem -pubout -outform DER | tail -c 32 | xxd -p -c 64
# Private half: base64 PKCS#8, entered only into the owner's secrets run as ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64.
openssl pkey -in <offline dir>/still-access-current.pem -outform DER | base64 | tr -d '\n'
```

Repeat for the standby key and keep its private half offline until a rotation. The server secrets are
`ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64`, `ACCESS_PROOF_PUBLIC_KEY_HEX` (the same hex as the pinned row),
`ACCESS_PROOF_KEY_ID` (the same kid) and `ACCESS_PROOF_ENVIRONMENT=production`. The kid is a name the owner
picks, not a provider credential.

### Checking the server against the pinned file

The server refuses to sign unless its private key matches `ACCESS_PROOF_PUBLIC_KEY_HEX`. So when that secret
matches a pinned row, every proof the server signs verifies in a store build. `supabase secrets list -o json`
prints a SHA-256 digest of each secret, never the value. Pass that output to

```bash
node scripts/release/access-trust.mjs compare-server --secrets-json <file>
```

It prints PASS or FAIL for three checks: the server's public key is a pinned row, the kid matches that row,
and the environment is `production`. It also says whether the server signs with the current or the standby
key. It prints no value or digest and exits 1 on any FAIL. A file that is not that JSON list (a `.env` passed
by mistake, say) gets a fixed message; none of its contents is printed.

**Release gate.** Once a release declares the paid tier, every store build requires the same digests and
refuses unless the comparison passes. Only the three entries `ACCESS_PROOF_ENVIRONMENT`, `ACCESS_PROOF_KEY_ID`
and `ACCESS_PROOF_PUBLIC_KEY_HEX` are read; keep only those three when you save the list (they are digests
of public values).

- `package.mjs`: `--server-secrets-json <file>`.
- Chrome release workflow: the `chrome-release` environment variable `ACCESS_PROOF_SERVER_DIGESTS_JSON`
  holds those three entries as JSON. Set it in the release PR's runbook step after setting the server
  secrets.
- `archive.sh`: `ACCESS_SERVER_DIGESTS_FILE=<file>`; for a raw archive pass `--server-secrets-json <file>`
  to `access-trust.mjs check` and `apple-apply`.

For a free release the digests are optional; when given, they must still match.
