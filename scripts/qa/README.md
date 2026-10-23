# V3 QA profiles

The ordinary `pnpm build` and package build commands retain their current release selection.
These additional commands select the existing modern browser runtime and Apple atomic settings
together, in production bundler mode with production rule trust. They build web resources only.
They do not enable paid sales, configure access-signing keys, package native apps, or publish anything.

```bash
pnpm build:v3:local                       # all four web-resource targets, no backend
pnpm build:v3:local chrome                # chrome, firefox, safari, or apple-webview
pnpm test:build-profiles
```

On a source with the paid tier on (the 3.x line), `local` and `test` also require
`STILL_QA_BACKEND_ROUTE_PROFILE=shared-hosted-sandbox` and refuse before building otherwise: such a
package carries the store identity and version, so it must never reach production purchase routes.
Both paid constants must appear exactly once and agree (both off or both on).

Use `node scripts/qa/v3-profile.mjs local chrome` directly if a pnpm launcher attempts to
replace the installed dependency graph. Install dependencies normally before building; the runner
loads each package's installed WXT/Vite API rather than invoking a package-manager wrapper.

`local` ignores all inherited `VITE_*` inputs and each package's `.env*` files. Each target builds
in a fresh process with an empty environment-file directory. Both runtime flags are exactly `true`:
`VITE_MODERN_SETTINGS_SYNC_ENABLED` and `VITE_APPLE_ATOMIC_SETTINGS`. No backend, analytics or review
sign-in configuration is supplied. Browser local blocking remains usable; Safari/App Group behavior
still requires the matching native authority and native/device verification.

The owner-approved hosted QA arrangement uses the existing backend with dedicated test accounts.
It requires no separate staging backend. Supply only these public client inputs from the verified
existing configuration through the local shell, without committing or printing their values:

- `STILL_QA_BACKEND_ENVIRONMENT=shared-hosted`: explicit assertion of the approved shared backend arrangement.
- `STILL_QA_SUPABASE_URL`: the existing hosted backend's HTTPS origin.
- `STILL_QA_SUPABASE_ANON_KEY`: its public anonymous JWT or publishable client key.

```bash
pnpm build:v3:test
pnpm build:v3:test firefox
```

The test command refuses missing/partial configuration and secret/service-role client keys. It
does not invent a target, start a database, contact providers, or establish deployed correctness.
Backend migrations/function configuration and real OTP/two-client sync journeys remain gates.
Physical TestFlight connectivity and dedicated test-account isolation still require real journeys.
Keep sandbox purchase rights separate from production rights; these build commands confer none.

Outputs live under `.output/v3-qa/<local|test>/<surface>/artifact/`, isolated from each package's
ordinary `dist/`. A successful build writes `artifact-manifest.json` alongside its artifact with
Git revision, dirty state, source fingerprint, runtime selection, backend-target fingerprint,
trust limitations and exact file sizes/SHA-256s. Endpoints and client keys are absent from the
receipt. The client necessarily embeds the configured public endpoint/key; keep test artifacts local.
The manifest is removed before a rebuild, so failed builds cannot reuse a previous success receipt.
Files identify font/JS/CSS and total download bytes; startup/observer timing needs separate
comparable packaged-runtime measurements. Apple embeds the font in its single-file HTML.

The ordinary `local` and `test` scoped-access clients default to production trust with no access keys.
These two profiles
therefore reject sandbox access proofs and mark sandbox fulfillment/host trust wiring outstanding.
Setting an arbitrary sandbox `VITE_*` variable cannot change this. Actual sandbox provider/native
evidence remains necessary before paid journeys can pass. The production bundler mode never
selects development rule keys; an empty production
allowlist holds remote updates safely. No QA profile is a store-release or TestFlight certificate.

The Apple webview output intentionally has no ordinary `dist/.env-state` archive stamp: it cannot
be substituted for a guarded release build. Use the existing native release procedures when native
configuration and hosted sandbox fulfillment are ready. Compare package `dist` baseline and this
profile only when their backend/flags and measurement conditions match.

## Additional paid-sandbox tooling inputs

The existing `paid-sandbox` profile and [Apple QA configuration parser](../../apps/apple/scripts/paid-sandbox-qa.mjs)
require the shared-hosted public inputs listed above and three additional shell inputs:

- `STILL_QA_ACCESS_ENVIRONMENT`: exactly `sandbox`; production or an unspecified environment is refused.
- `STILL_QA_ACCESS_PUBLIC_KEYS`: a JSON array of one to eight distinct public access-verification
  keys. Each record contains exactly `kid`, `publicKeyHex`, `purpose: "access"` and
  `environment: "sandbox"`. The parser validates identifier and public-key encoding.
- `STILL_QA_REVENUECAT_PUBLIC_API_KEY`: the Apple public RevenueCat SDK key (`appl_` prefix).
  Server API keys, issuer private keys and signing-credential inputs are refused.

Keep actual values in private local configuration. These are additional inputs to the separate
sandbox tooling; ordinary `local` and `test` profiles retain their configuration above. Documenting
them does not run a purchase, sign/publish an artifact or establish hosted/provider/device readiness.

## Installable sandbox QA packages

Paid-sandbox browser packages carry their own identity: Chrome and Firefox show the name
"Still QA Sandbox (not for release)", and Firefox uses the separate add-on id
`still-qa-sandbox@chartash.com`. A listed store update can never replace an installed QA build, and
the QA build is never uploaded through the public listing. Store packaging never forwards
`VITE_PACKAGE_IDENTITY`.

- **Firefox desktop and Android.** `node scripts/qa/firefox-qa-sign.mjs <firefox-mv3 dir> <out>` checks
  the built QA package and prints the upload plan without contacting Mozilla. Adding `--submit` signs
  it on AMO's unlisted (self-distribution) channel using the private 0600 credentials file named by
  `STILL_QA_AMO_CREDENTIALS_FILE`. It refuses the store id, never retries a write after an upload, and
  verifies that the signed XPI is the uploaded files plus Mozilla's signature. Each signing needs an
  unused QA version. Submitting is an external action that needs the owner's approval.
- **iPhone and Mac.** The `apple-ios-device` and `apple-macos-device` targets archive, then export a
  development-signed `Still.ipa` or `Still-mac.zip` locally, without provisioning updates or upload.
  The receipt requires the reviewed team's unexpired, device-limited profile and the shared App Group
  in both the app and its Safari extension. Such a build cannot be submitted to the App Store, and
  StoreKit uses the sandbox. It shares the store app's bundle id, so installing it replaces the store
  app on that device until the store app is reinstalled.

These packages establish signing and identity only. Hosted sandbox configuration, provider
readback and installed-device journeys remain separate gates.

### Before delivering a paid-sandbox package: the sandbox sales allowlist

A browser QA build can offer a sandbox purchase only if its exact manifest version is listed for its
surface in the published sandbox sales policy. Otherwise it shows "Still Pro can't be bought here
yet." Apple hosts are listed by marketing version (2.1.0), so a new Apple build number needs no change.
Every QA package card states the allowlist revision it was checked against:

1. Read the published policy: `POST {"namespace":"sales","environment":"sandbox"}` to
   `/functions/v1/qa-sandbox-product-policy` on the sandbox project. Note its `revision`.
2. Check that the package's web version (for example `2.1.1.371`) is listed for `chrome_desktop`,
   `firefox_desktop` and `firefox_android`.
3. If it is not, add the three entries to `QA_SANDBOX_SALES_BUILDS` in
   `scripts/backend/deploy/operations.mjs` and to both `qa-sandbox-sales-policy-{on,off}.sql`
   templates (re-pin their hashes), merge, and publish the next revision with the protected
   `qa-sandbox-sales-policy` operation (mode `on`, the current revision as expected revision).
   Merging that change advances the QA sequence, so list the version of the package already built.
4. Write `Sandbox sales allowlist revision: <n> (lists <version> for the three web surfaces)` on
   the package card. A card without that line is not ready to deliver.

### Integration packages (main plus unmerged PRs)

A paid-sandbox package is normally built from a clean commit on origin/main's own first-parent line,
and its fourth version number is that commit's first-parent count, so it never repeats and Mozilla
can sign it once. To test approved PRs together before they merge, create a local branch from
current origin/main, run `git merge --no-ff <pr-branch>` for each PR, check the branch out clean, and
build with `STILL_QA_INTEGRATION_BRANCH=<branch>` set; nothing else turns this mode on, and the
release builder ignores it. The builder refuses unless the checked-out commit is that branch's head
(or on its first-parent line), the branch starts from a commit on main's own line (its base), every
commit above the base is a merge, and the package contains no main commit newer than the base (for
example a PR branch that merged a newer main). Because only merge commits may sit above the base, a
fix-up commit cannot live on the integration branch itself: a fix, including the resolution of a
semantic conflict between two PRs that merge cleanly, has to live in a PR branch or inside the merge
commit that brings it in. The number is the base's count on main plus 1000 (a
base at count 438 gives 1438, as in `2.1.1.1438`), and the build refuses unless it is more than 500
above main's current count, so main needs more than 500 further merges to reach it. Main keeps
growing, so the store version must change (3.0.0 at release) before main's count reaches the lowest
integration number used while the current version string is in use. The same base gives the same
number, and Mozilla signs it only once: to change the merged PRs, re-cut the branch from current
origin/main, and if origin/main has not moved since the last cut, wait for the next merge to main
before re-cutting. Every `artifact-manifest.json` then carries an `integration` block (also bound
into `paidBuild`): the branch name, the base commit and its count, main's count at build time, the
sequence, and each merged head's full SHA and subject, oldest first. The package card copies that
block, says plainly that the package is not built from main, and, like every card, names the sales
allowlist revision that lists the integration version.
