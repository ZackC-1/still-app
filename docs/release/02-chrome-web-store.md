# Track 2 — Chrome Web Store

Current reference for Still 2.0.0, reviewed September 14, 2026. The owner reported submitting 2.0.0
for review; the last recorded public-page check still showed 1.0.3. See the
[dated release record](history/2026-09-14-release-status.md#store-snapshot). Submission is not publication;
check live status before the next store action.

## Artifact and supported scope

The Chrome package is `packages/ext-chromium/dist/chrome-mv3`. It is a desktop MV3 extension,
with `storage`, `declarativeNetRequestWithHostAccess`, and host access restricted to the four
supported services. There is no `tabs`, `activeTab` or `<all_urls>` permission.
Chromium uses network-layer Shorts redirection with the content-script SPA fallback.

For a future authorized candidate:

```bash
pnpm install --frozen-lockfile
pnpm --filter @still/ext-chromium build
pnpm --filter @still/ext-chromium zip
```

Use the frozen candidate's toolchain and explicit public Supabase configuration. An unconfigured
bundle still blocks all four services for free but cannot offer its configured cloud sign-in/sync.
Never replace an already submitted ZIP to align it with a later documentation commit.

## Store listing and screenshots

Use [current listing copy](store-listing-copy.md#chrome-web-store) and
[public contacts](public-contact-addresses.md). Describe free Shorts/Reels removal, TikTok website
blocking, no account needed, and optional free sync with desktop Chrome/Firefox and Safari on
Mac/iPhone/iPad. Mobile use is Safari through the Still Apple app; this extension does not run in
mobile Chrome or Firefox or modify native social apps.

The owner updated the two [functional screenshots](screenshots/store-ready/README.md#chrome-web-store)
and reviewer instructions before submission. Keep controls first, sync second, along with the
existing icon and brand promotional tiles. No $1.99, locked Pro features or checkout steps belong
in the free listing. Preserve the existing listing and selected distribution regions.

## Privacy declarations

- Single purpose: remove short-form distractions from the four supported websites.
- `storage`: local settings and session state; DNR: Shorts-to-watch redirects; hosts: apply
  supported-site blocking only.
- All executable code is bundled. Signed remote rule sets are data, not downloaded executable code.
- Optional account use processes email/authentication and synced settings. On-device website access
  is needed to apply rules; browsing history and page content are not uploaded by Still.
- Use `https://stillapp.fit/privacy/` and ensure the selected dashboard categories describe actual
  access/use and provider behavior. Do not reuse the old blanket “free users transmit no data” claim.

The screenshot of a checkbox or a saved draft is evidence of that form state, not a replacement
for implementation/privacy review. Preserve the approved provider-retention policy.

## Reviewer instructions

Test all four services without an account, toggle global/per-service controls, confirm normal
YouTube/Instagram/Facebook content remains and TikTok is blocked. Optional sync uses an emailed
six-digit code and the same account on a second supported installation. No Unlock Pro or checkout
step is required. Keep private access details in the dashboard's private fields only.

## Release completion

Verify the reviewed package version and saved metadata, then follow the current portal's publication
flow. Once public, inspect the actual listing/download and confirm the free description, screenshots,
privacy link and expected 2.0.0 payload. Preserve earlier test evidence; outstanding hosted account
certification is tracked separately in issue #153. Broad promotion waits for the owner's coordinated
store rollout decision.

The [previous Chrome runbook](../archive/pre-2.0-reference-refresh/docs/release/02-chrome-web-store.md)
retains first-registration and paid-checkout history. It does not govern this release.
