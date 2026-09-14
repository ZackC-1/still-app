# Changelog

Still uses descriptive pull request titles and conventional commit-style summaries for changes from this point forward.

## 2.0.0 — free release (store rollout in progress)

Implementation and release changes recorded through September 14, 2026. Public availability varies
by store; see [the dated release record](docs/release/2026-09-14-release-status.md).

- All supported blocking is free: YouTube Shorts, Instagram/Facebook Reels and the TikTok website.
  No account or purchase is required; both paid-tier flags remain disabled.
- Optional free email-code sign-in syncs settings across desktop Chrome/Firefox and Safari on
  Mac/iPhone/iPad. Improved first-account adoption, reconnect/upload recovery, account status,
  local sign-out and isolation from delayed callbacks across account changes.
- Improved YouTube Shorts filtering while preserving mobile renderers, regular videos and search
  continuation behavior. Controls work across all four services; legacy pause state is normalized.
- Refined configured popup sizing, Apple onboarding text wrapping and setup instructions.
- Hardened account exports against partial read failures; deployed derived security-counter
  retention/cleanup and removed request-IP/error details from review-sign-in application logging.
- Retained RevenueCat identity, historical entitlements and receipt infrastructure with purchase
  presentation dormant. The approved privacy notice documents separate billing/support/provider retention.
- Updated public contacts, free store descriptions, controls/sync screenshots, website/download
  links, setup guides and consistent 14-day historical web-refund wording.
- Reconciled dependency PRs, updated development toolchain/CI, and organized repository references
  and historical material. These later maintenance changes do not rebuild submitted store packages.

## Earlier implementation history — June/July 2026

These entries previously appeared under Unreleased. They preserve the earlier paid-release work;
they are not current 2.0.0 purchase requirements or artifact versions.

- Truthful OTP sign-in error handling (Guideline 2.1(a) resubmission): rate-limited sends and
  verifies now render calm wait states with locked buttons instead of "try again" copy that
  invited hammering the limit; non-OTP failures no longer dead-end as "wrong code"; a stale
  reopened code entry lands on the expired presentation directly.
- Deterministic App Review sign-in: one designated review address accepts a fixed verification
  code minted server-side by a new guarded `review-signin` edge function (no email is ever sent;
  fail-closed at every layer; disclosed in App Review notes; normal OTP for everyone else).
- Apple purchase-first Pro flow (Guideline 5.1.1 resubmission): Still Pro is purchasable on iPhone
  and Mac with no account — entitlement comes from the Apple receipt, an optional post-purchase
  sign-in adds cross-surface Pro and settings sync, and Restore Purchases works signed out. The
  App Group entitlement stamp gained a source-aware never-downgrade policy (ADR 0003); the macOS
  deployment floor rose to macOS 12.
- Centralized the extension session protocol and entry wiring shared by the Chromium, Firefox, and Safari builds.
- Scoped engine rule work per page and removed the unused hide-CSS generation seam.
- Ignored stale Apple entitlement callbacks and stopped the Safari reconcile nudge after teardown.
- Staged the post-approval release versions: browser stores 1.0.3 and Apple 1.0.3 (build 4).
- Added server-authoritative near-realtime settings sync across browser and Apple surfaces.
- Hardened Safari App Group reconciliation and extension wake paths.
- Added signed macOS and iOS build validation plus a current cross-surface release test record.
- Removed stale session instructions and personal test-account identifiers from public documentation.
- Corrected contributor setup and unpacked-extension paths.
- Added public repository health files: contribution guide, security policy, support page, code of conduct, issue templates, pull request template, CODEOWNERS, and Dependabot configuration.
- Refreshed the README for outside readers and added a documentation index plus architecture overview.
- Updated GitHub repository metadata and cleaned up vague historical PR titles where GitHub allows non-destructive edits.

## 2026-07-07 Public Repository Readiness

- Documented the source-available licensing posture.
- Made privacy, security, CI, branch protection, release operations, and architecture easier to verify from the repository landing page.
