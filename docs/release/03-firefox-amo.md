# Track 3 — Firefox Add-ons (AMO)

Current reference for Still 2.0.0, reviewed September 14, 2026. Use the
[dated release status](history/2026-09-14-release-status.md#store-snapshot) before an external action.

## Current distribution status — verified September 11, 2026

Still 2.0.0 was verified public on [AMO](https://addons.mozilla.org/en-US/firefox/addon/still-free-yourself/)
on September 11 and rechecked September 14. The recorded public API returned version 2.0.0,
status public and no payment required. Free/sync copy, current screenshots, complete sources and
reviewer notes were saved. This documentation refresh is not a fresh live API check.

Publication does not certify every store-installed host/account journey. Preserve candidate-specific
evidence and issue #153's remaining hosted lifecycle work; do not resubmit because an old audit row
remains unverified.

## Artifact and manifest

The Firefox target shares `packages/ext-chromium` with Chrome and builds to `dist/firefox-mv3`.
It uses content-script Shorts redirection, without Chromium's DNR permission/rules.

| Manifest field | Current source value |
|---|---|
| `manifest_version` | 3 |
| `gecko.id` | `still@chartash.com` — permanent identifier, not a contact mailbox |
| `gecko.strict_min_version` | `140.0` |
| `gecko.data_collection_permissions` | `required: ["authenticationInfo"]` |
| `gecko_android` | Omitted; desktop-only support |
| Permissions | Storage and the four supported website hosts; no `<all_urls>` |

All blocking is free without an account. Optional email-code sign-in syncs settings for free;
there is no purchase requirement. Do not add Android compatibility or change the stable identifier
as metadata housekeeping.

## Complete source reproduction

For a future authorized build:

```bash
pnpm install --frozen-lockfile
pnpm --filter @still/ext-chromium build:firefox
pnpm --filter @still/ext-chromium zip:firefox
```

Use the candidate's pinned toolchain. Current main's toolchain is documented in the
[root README](../../README.md#development); submitted source archives retain their own lockfile and
build prerequisites. Do not retrofit them with current dependencies.

WXT's package-only source ZIP is insufficient for this monorepo. Pair the extension ZIP with the
complete tracked workspace, frozen lockfile, explicit allowlisted public build configuration (from
2.1 it must include `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST`, which are public, or the rebuilt
add-on will not match the submitted one) and
its `AMO-REBUILD.mjs` instructions. Never copy an ignored `.env` wholesale. Extract in a clean
directory, reproduce all packaged files and compare their contents before uploading. Store and
record source/package hashes together; ZIP timestamp differences are not payload differences.

## Listing, privacy and reviewer notes

Use [current listing copy](store-listing-copy.md#firefox-add-ons),
[public contacts](public-contact-addresses.md) and the
[current screenshot order/captions](screenshots/store-ready/README.md#firefox-add-ons-amo).
Set no payment required. Describe desktop Firefox plus optional free sync with separate desktop
Chrome and Safari installations on Mac/iPhone/iPad. Mobile support means Safari websites, not
Firefox mobile or native social apps.

Disclose optional account authentication/settings and actual website access consistently with the
manifest and [privacy policy](https://stillapp.fit/privacy/). Do not claim free users make no
network requests or describe the source-available repository as open-source licensed.

Reviewers test all four services signed out, global/per-service controls, ordinary-content
preservation, and optional email-code sync. No purchase/restore/checkout step is needed. Supply
private account access privately if required, plus reproducible source instructions.

## Existing-listing update: publication boundary

**Continue after upload validation can publish an update before a later Submit Version button.**
Have the package, full source, notes and metadata ready before advancing. Do not assume review
will hold an upload as a draft. Check developer/public state after advancing and verify source
and notes persisted. See the [AMO publication lesson](../solutions/conventions/amo-continue-can-publish-an-update.md).

For a future authorized update, inspect the current validator and address actual findings. Preserve
historical warnings as evidence of their named package, not permission to dismiss new warnings.
The [previous Firefox runbook](../archive/pre-2.0-reference-refresh/docs/release/03-firefox-amo.md)
retains the old paid-launch instructions and validation history.
