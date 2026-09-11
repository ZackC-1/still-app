# Still 2.0 release runbook

Current Firefox distribution: [Still 2.0.0 is public on AMO](03-firefox-amo.md#current-distribution-status--verified-september-11-2026),
verified September 11, 2026. Apple and Chrome 2.0 updates remain pending.

Latest copy preparation: [free Still 2.0 copy and publication gates](2026-09-11-free-release-copy.md).

Latest source/artifact review: [September 11 public contact update](2026-09-11-public-contact-update.md).
It records the current contact addresses, fresh distribution exports, verified backend deployment
and remaining public-release gates. The [September 10 PR reconciliation](2026-09-10-pr-reconciliation.md)
records the preceding integration and test evidence.

Still removes YouTube Shorts, Instagram and Facebook Reels, and blocks the TikTok website for
free on every supported surface. An account is optional and enables cross-device settings sync.
On iPhone and iPad, Still works in Safari websites; it does not block native social apps.

The 2.0 candidate must pass [release certification](2026-09-08-still-2-certification.md).
[VALIDATION.md](VALIDATION.md) distinguishes current evidence from previous releases. Historical
portal status in [the launch record](launch-progress-2026-07-13.md) must be verified live before
an external action.

Customer-facing email addresses and store upload checklist: [public contact addresses](public-contact-addresses.md).

## Release tracks

| Track | Deliverable | Required evidence |
|---|---|---|
| [Apple](01-apple-app-store.md) | Version 2.0.0 native apps and Safari extensions | Signed Release archives, export validation, native macOS/Safari and physical iPhone/iPad journeys |
| [Chrome](02-chrome-web-store.md) | Version 2.0.0 Chromium ZIP | Installed candidate, actual toolbar/options, supported-site behavior |
| [Firefox](03-firefox-amo.md) | Version 2.0.0 Firefox ZIP and complete reproducible sources | Actual Firefox host behavior, clean source rebuild, AMO distribution status recorded separately |
| [Mobile](06-mobile-blocking-validation.md) | Safari website behavior | Physical-device evidence for the exact candidate |

RevenueCat identity and purchase infrastructure remain present with both paid-tier flags disabled.
The [RevenueCat runbook](04-revenuecat.md) documents that retained infrastructure; enabling paid
behavior or changing its provider configuration is outside this release. Sign-in must never gate
blocking. No purchase journey is an activation prerequisite for 2.0.

## Prepare and verify

1. Review and integrate the settings-lifecycle, export-error, popup-layout and retention fixes
   tracked by issues #149–#152 into an isolated candidate. Record each exact reviewed commit.
2. Verify the intended backend revision and migration requirements against the retention runbook.
   Prepare deployment and legacy-data purge for explicit approval; do not deploy as a smoke test.
3. Build fresh configured artifacts with approved public runtime configuration. Test configured
   and unconfigured bundles with synthetic config separately; dummy config is not a release setup.
4. Freeze source and configuration, record artifact SHA-256s and embedded versions, and scan the
   final payloads. Preserve the complete workspace and frozen lockfile for AMO reproduction.
5. Run automated gates and the actual host/device journeys in the certification record. A missing
   device or signing identity remains an unverified row. Unit tests cannot certify it.
6. Review the store-copy drafts and #152 privacy draft for consistency with the candidate. Obtain
   explicit approval for release-branch merges, production deployment/purge, privacy publication,
   store metadata changes and upload/submission of the identified artifacts.

## Stable identifiers and boundaries

| Item | Value |
|---|---|
| Apple application ID | `com.chartash.still` |
| Apple extension ID | `com.chartash.still.Extension` |
| Apple App Group | `group.com.chartash.still` |
| Apple team | `UM9HVDH3P3` |
| Firefox add-on ID | `still@chartash.com` |
| Retained entitlement / Apple product | `still_sync` |
| Retained web product/package | `still_sync_web` |
| Website host permissions | YouTube, Instagram, Facebook and TikTok only |

Firefox remains desktop-only. Android/native social-app blocking is not advertised. Still does
not collect browsing history. Account deletion must follow the approved retention policy while
preserving the local last-synced-account marker that prevents settings crossing accounts.
