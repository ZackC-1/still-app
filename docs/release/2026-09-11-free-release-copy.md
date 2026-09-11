# September 11 — free Still 2.0 release copy

This records the copy-preparation snapshot. Later Firefox publication is recorded in the
[current Firefox release status](03-firefox-amo.md#current-distribution-status--verified-september-11-2026);
use the release tracks for current operational state.

The owner confirmed that Still 2.0 is free to grow adoption: all four blocking services without an
account and optional free sign-in for settings sync. The approved refund window is 14 days for
previous web purchases; Apple handles Apple purchase refunds under its own policies.

## Prepared changes

Strategy, agent guidance, README, store listing copy, marketing guidance, homepage, guides, support,
and Terms now describe the free release. Apple, Chrome, and Firefox copy uses the public
support/privacy/hello addresses. The sharing image was regenerated with free 2.0 text. The old
homepage video was removed because its final screen advertises $1.99 Pro. It remains a historical
asset and must not be reused in release promotion.

The source update merges to main. The separate gh-pages change is a draft for coordinated 2.0
publication. No store metadata, uploads, pricing, or production provider settings changed.

## Verification

- Lint, typecheck, build and 788 unit tests passed, with 39 intentional dormant-paid tests skipped.
- Support and Terms contain identical earlier-web-purchase refund wording.
- Store field lengths: Apple name 27/30, subtitle 23/30, promotional text 141/170, keywords 86/100
  bytes; Chrome summary 109/132; Firefox summary 160/250 characters.
- Website sharing image inspected at 1200×630. Mobile homepage inspected at 375px.
- All 28 page/viewport checks passed in Chromium at 375px and 1440px, with no failing requests,
  console errors or horizontal overflow; evidence is retained
  in the private release-gate record. Root-relative styles and setup logo fix directory-alias assets.
- Application runtime code is unchanged. The signed contact-update artifacts identified in
  [the preceding release record](2026-09-11-public-contact-update.md) remain the candidate.
  Only an existing style-link test changed alongside documentation and website assets.

## Publication gates

1. Review and replace the detailed privacy policy after provider logging, backup and deletion checks.
   This change only updates its product description. Its old “collect nothing” and complete-deletion
   wording is not approved for 2.0 publication. Store data declarations remain open too.
2. Finish exact-candidate host/device journeys and capture current store screenshots. Existing
   paid-era screenshots are unsuitable even when their filenames say `store-ready`.
3. Verify each store's live version and pricing before publishing the matching 2.0 listing and site.
   At the initial September 11 copy check, Firefox still described version 1.0.3 and paid features.
   Later that day, 2.0.0 became public with free/sync copy and payment disabled, as recorded above.
   A staggered rollout needs explicit per-store availability labels before the website can publish.
4. Set the Terms effective date to its actual publication date when publishing, if later than the
   preparation date. Verify both `.html` and directory URLs after the gh-pages deployment.

Issue #171 remains open until the corrected policies are live. Release remains not ready pending
these and the authentication/device/store gates in [the release runbook](README.md).
