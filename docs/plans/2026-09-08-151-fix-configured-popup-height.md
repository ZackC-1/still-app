---
title: Fit the sync-configured popup within its desktop height contract
date: 2026-09-08
status: ready-for-review
owner: Codex Astra
branch: fix/151-configured-popup
---

Issue #151 specifies the public seam: a freshly built extension popup at 380×600, including its
laid-out controls and initial scroll position. The unconfigured build is the healthy control.
The approved free-tier release keeps all supported blocking free and sign-in optional for sync;
older paid-tier strategy passages are superseded for this work. Both monetization flags remain false.

Scope: compact App.svelte spacing, extension.spec.ts behavioral coverage, and CI's fresh configured
and unconfigured builds. Preserve copy, fonts, control sizes, width preferences/clamps, normal
scrolling for larger text, and dormant paid/auth infrastructure. No dependencies or refactors.

1. Install frozen dependencies and reproduce the existing configured geometry failure before edits.
2. Make the smallest compact spacing adjustment and prove configured geometry passes.
3. Add explicit configured-capability checks and exercise relevant auth, width, theme, keyboard,
   and accessibility states through the bundle boundary; isolate all external traffic synthetically.
4. Build/test both CI variants afresh. Remove only the production fix and prove regression failure;
   restore exact bytes and rerun the healthy check.
5. Run lint, typecheck, UI/full unit tests, builds and the full fixture suite; record actual host
   coverage and limits. Update the existing visual-contract learning. Commit for independent review.

References: docs/ARCHITECTURE.md; docs/solutions/conventions/codify-cross-platform-visual-contract-in-tests.md;
GitHub issue #151. Native Safari/iPhone acceptance belongs to issue #153. Rollback is the scoped
commit revert. No deployment, production call, store action, or release-branch push is involved.

Verification evidence:

- Fresh configured baseline and strengthened regression failed at 610 > 600; fresh unconfigured
  baseline passed. Final fix changes only compact section gap and sync-card padding from 8 to 4px.
- Removing those production adjustments, rebuilding, and rerunning the configured test fails at
  610px; original source bytes restored with identical SHA-256.
- Actual configured Chrome toolbar measures 380px wide with content bottom589.578px in light/dark;
  actual Firefox configured document measures 594.567px. Firefox toolbar hosting is unverified.
- Chromium and Safari bundles: 320/375px light/dark and keyboard controls pass. Minimum-font24
  remains reachable by scrolling (half-pixel scroll-rounding tolerance). Synthetic runtime replies
  exercise consent, sending, send failure, signed-in and unavailable-background UI without sessions.
- Lint/typecheck pass; focused App tests34 pass/21 dormant skips; full unit701 pass/39 dormant skips.
  Full fresh configured fixtures44 pass. Final fresh unconfigured fixtures44 pass.
- Updated the existing visual-contract learning with capability-specific fresh build coverage and
  the Chromium/Gecko geometry difference. Independent review belongs to the coordinating session;
  Safari engine/device and signed release acceptance remain final certification gates.
