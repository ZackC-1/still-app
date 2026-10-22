---
title: Dead code and obsolete test audit
date: 2026-10-21
status: complete
owner: Codex
---

# Dead code and obsolete test audit

The owner advanced this audit to October 21, before the final screen/image edits scheduled for
October 22. Audit reviewed main `26bf5a947de9fef70102c9be87f1e69806cbce46` in an isolated
worktree. Preserve the main checkout and the separate visual session's files.

## Scope and decision rules

Review application packages, browser/Safari entry points, Apple/StillKit code, backend functions,
build scripts and tests. Use static analysis and three parallel review lanes: application runtime;
backend/native/build code; and test value with related stale comments. Remove only proven unused
code or obsolete tests. A missing static import alone is insufficient for framework exports,
dynamic entries, native bridges, workflow/CLI targets or persisted/external contracts.

Preserve shipped compatibility, account isolation, historical purchases, RevenueCat identity,
privacy, security and release gates. Tests that fail before changes are defects to investigate,
never deletion candidates. Test removal requires passing baseline evidence and a stronger retained
test for the same failure, or proof the test asserts nothing that can fail. Keep useful regressions.

Do not change final visuals, production state, sales/review/analytics switches, dependencies merely
to satisfy an analyzer, or generated assets. No size or performance improvement is claimed without
measurement. The existing authorization covers applying proven cleanup and opening a reviewed PR.

## Verification

Establish lint/typecheck and relevant passing tests before edits. Recheck candidates against current
source, apply bounded removals, then run lint, typecheck, workspace tests, build and fixture
Playwright checks. Run Deno/Swift/Xcode checks when those paths change. Record false positives,
retained compatibility and audit limits alongside the actual change and evidence.

## Results

Three parallel review lanes and an independent adversarial review selected these bounded changes:

- Remove the retired RevenueCat Purchase Link handler/transport and its two dedicated test files.
  All 26 configured Edge Function dependency graphs exclude that implementation; the current
  entry point selects managed checkout. The 20 retired tests passed before deletion. Current
  managed checkout, auth, rate-limit and historical RevenueCat receipt coverage stays.
- Remove two unused deployment-file accessor wrappers, an unused QA processor wrapper and an
  unused QA deleted-account type alias. The existing central freshness check still reads
  `plan.files`; the shared checkout processor and deleted-account handling stay.
- Remove one unused Chromium policy-path constant. Make three locally consumed extension helpers
  private without changing their bodies. Remove one duplicate Boolean consent assertion; the two
  stronger exact-output tests still exhaust the Boolean inputs.
- Keep the entire account-deletion error suite, including classification/redaction assertions and
  live PostHog/RevenueCat throw sites. Remove only its assertion against the retired billing class.

The simplification review applied two reuse findings, seven quality findings and two test-value
findings. It selected no efficiency or standalone comment edits. Public package exports, dynamic
onboarding markers, capability/test seams, native OS/storyboard callbacks, shipped tier derivation,
legacy receipt paths, migrations and operational scripts were retained. Raw analyzer output is
candidate evidence, not proof: it reports framework entries and public barrels as unused.

## Evidence and limits

- Import/re-export screening covered 640 application source files. Compiler unused-symbol checks
  found no further unused locals/imports in core, Chromium, Safari or owner-admin. Candidate test
  review considered the wider test inventory but did not read every assertion in every file.
- Full remaining Deno suite: 631 tests and 147 steps passed, zero failed, one separately gated test
  ignored. Deno lint checked 150 files. Existing deployment tests: 113 passed.
- Post-change Safari: 405 passed; owner-admin: 58 passed; app-webview: 19 passed. Three targeted
  frontend baseline sets passed 90, 36 and 37 tests. Final workspace/fixture gate evidence belongs
  to the cleanup PR's required checks.
- All 14 production upload bundles are byte-identical before and after. All 114 web build files
  are byte-identical, totaling 6,048,431 bytes. No package-size or runtime improvement is claimed.
  Three QA upload bundles changed minified identifier names; their sizes, AST structure/literals
  and externally named properties are unchanged. Binding-aware comparison also found zero changed
  declaration/reference relationships or unresolved names. All 22 JWT settings are unchanged, and all
  26 current Edge Function entry graphs resolve. Existing QA receipt source pins remain historical;
  a claim of a newly deployed QA source would need its own protected operation.
- Baseline lint, typecheck and build passed. The local unbounded workspace test run hit timing
  failures before cleanup and was stopped; it is not recorded as a pass. A two-worker core run
  also encountered existing native/DOM timing limits. A Chromium lazy-view test failed during
  initial setup, before its scenario; a clean-base comparison is recorded in the PR. These tests
  are retained without relaxed assertions or timeouts. Final verification must distinguish these
  baseline limits from cleanup regressions.
- Adversarial review found no actionable blocker. Unpublished downstream code and tomorrow's
  final visual changes are outside the evidence. No native source changed, and no Apple device
  verification or production mutation was performed.

Deployment tooling is freshness-bound. After merge, any new protected analytics/sales/review plan
must use the reviewed merged revision or a descendant, with a successful exact-revision settings
rehearsal. Existing deployed production bytes are unchanged; this cleanup does not require a
production redeployment or another activation approval now.

## Delivery

[PR532](https://github.com/ZackC-1/still-app/pull/532) merged as
`fb45a271da31ed3304770d70035a5f3d17874d4f` after all 31 CI checks passed. Its Git tree matches
reviewed head `b3e6878c2c1148a73181b3e79770a944185e86a6`. Required CI passed full workspace
checks and Deno, then all three browser profiles:367 passed/37 skips,212/192 and96/one skip,
with no failed/flaky cases. Local fixtures also passed367/37. Final lint/typecheck/build pass.
The documented local Mac timing limitations were retained without weakened assertions or timeouts.
No production deployment, QA deployment or final visual change was required.
