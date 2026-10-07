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

Current scoped-access clients default to production trust with no access keys. Both QA profiles
therefore reject sandbox access proofs and mark sandbox fulfillment/host trust wiring outstanding.
Setting an arbitrary sandbox `VITE_*` variable cannot change this. U5/U6 must deliver reviewed
environment-bound proof transport and actual sandbox provider/native evidence before paid journeys
can pass. The production bundler mode never selects development rule keys; an empty production
allowlist holds remote updates safely. No QA profile is a store-release or TestFlight certificate.

The Apple webview output intentionally has no ordinary `dist/.env-state` archive stamp: it cannot
be substituted for a guarded release build. Use the existing native release procedures when native
configuration and hosted sandbox fulfillment are ready. Compare package `dist` baseline and this
profile only when their backend/flags and measurement conditions match.
