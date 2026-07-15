# Changelog

Still uses descriptive pull request titles and conventional commit-style summaries for changes from this point forward.

## Unreleased

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
