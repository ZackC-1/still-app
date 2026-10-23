# Track 2 — Chrome Web Store

Reference for the Still 3.0.0 Chrome release. The paste-ready 3.0 listing, Privacy practices tab
and test instructions are in [V3 Chrome Web Store](store-listing-copy.md#v3-chrome-web-store); where
this page and that section differ, that section wins. The 2.0.0 submission of September 14, 2026 is
in the [dated release record](history/2026-09-14-release-status.md#store-snapshot). Submission is not
publication; check live status before the next store action.

## Artifact and supported scope

The Chrome package is `packages/ext-chromium/dist/chrome-mv3`. It is a desktop MV3 extension,
with `storage`, `alarms`, `declarativeNetRequestWithHostAccess` and host access restricted to the
four supported services. There is no `tabs`, `activeTab` or `<all_urls>` permission.
Chromium uses network-layer Shorts redirection with the content-script SPA fallback.

For a future authorized candidate:

```bash
pnpm install --frozen-lockfile
pnpm --filter @still/ext-chromium build
pnpm --filter @still/ext-chromium zip
```

For a hashed, byte-reproducible package use `node scripts/release/package.mjs` instead of `wxt zip`; see
[versioning and packages](versioning-and-packages.md). To build, upload and submit through the
owner-approved GitHub workflow instead of the dashboard, see
[Chrome Web Store release workflow](chrome-publish-workflow.md).

Use the frozen candidate's toolchain and explicit public Supabase configuration. An unconfigured
bundle still blocks all four services for free but cannot offer its configured cloud sign-in/sync.
Never replace an already submitted ZIP to align it with a later documentation commit.

## Store listing and screenshots

Use [current listing copy](store-listing-copy.md#chrome-web-store) and
[public contacts](public-contact-addresses.md). Describe free Shorts/Reels removal, TikTok website
blocking, no account needed, and optional free sync with desktop Chrome/Firefox and Safari on
Mac/iPhone/iPad. Mobile use is Safari through the Still Apple app; this extension does not run in mobile Chrome or modify native social apps.

The owner updated the two [functional screenshots](screenshots/store-ready/README.md#chrome-web-store)
and reviewer instructions before submission. Keep controls first, sync second, along with the
existing icon and brand promotional tiles. From 3.0 the listing names Still Pro as an optional
$9.99 one-time purchase, worded exactly as in [V3 Chrome Web Store](store-listing-copy.md#v3-chrome-web-store);
it never suggests that removing Shorts and Reels, blocking TikTok or sync needs a purchase. Preserve
the existing listing and selected distribution regions.

## Privacy declarations

- Single purpose: remove short-form distractions from the four supported websites.
- `storage`: local settings and session state; `alarms`: sends usage data at a later, random time so
  the send never reveals a site visit; DNR: Shorts-to-watch redirects; hosts: apply supported-site
  blocking only.
- All executable code is bundled. Signed remote rule sets are data, not downloaded executable code.
- Optional account use processes email/authentication and synced settings. From 3.0 the optional
  Still Pro purchase adds purchase records (financial and payment information); card details are
  entered on the payment provider's checkout page and never reach the extension. On-device website access
  is needed to apply rules; browsing history and page content are not uploaded by Still.
- Use `https://stillapp.fit/privacy/` and ensure the selected dashboard categories describe actual
  access/use and provider behavior. Do not reuse the old blanket “free users transmit no data” claim.

The screenshot of a checkbox or a saved draft is evidence of that form state, not a replacement
for implementation/privacy review. Preserve the approved provider-retention policy.

## Reviewer instructions

Test all four services without an account, toggle global/per-service controls, confirm normal
YouTube/Instagram/Facebook content remains and TikTok is blocked. Optional sync uses an emailed
six-digit code and the same account on a second supported installation. No purchase or checkout
step is needed to review; Still Pro is optional (see the V3 test instructions). Keep private access details in the dashboard's private fields only.

## Release completion

Verify the reviewed package version and saved metadata, then follow the current portal's publication
flow. Once public, inspect the actual listing/download and confirm the free description, screenshots,
privacy link and expected 3.0.0 payload. Preserve earlier test evidence; outstanding hosted account
certification is tracked separately in issue #153. Broad promotion waits for the owner's coordinated
store rollout decision.

The [previous Chrome runbook](../archive/pre-2.0-reference-refresh/docs/release/02-chrome-web-store.md)
retains first-registration and paid-checkout history. It does not govern this release.
