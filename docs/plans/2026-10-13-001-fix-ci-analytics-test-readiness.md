# CI analytics test readiness and install fixture types

Status: locally verified
Base: `5f60e8948ddbe26a8a4080b4e6e49eb4c0aa8803`
Branch: `fix/ci-analytics-bootstrap-20261013`

Main and several feature runs intermittently failed the Chrome default-on install analytics
assertion. A separate dependency update failed typechecking of install-event test fixtures.

## Scope

1. Keep the real analytics factories and assertions; wait with a bounded retry for both install
   events to be sent, flushing the background queue on each attempt.
2. Exercise the existing install case with normal and delayed storage reads.
3. Supply valid install/update/shared-module event payloads for both old and new Chrome types;
   isolate the cast to Firefox's extra `browser_update` reason.
4. Record the reusable asynchronous-test lesson in the existing analytics solution.

Application code, dependency versions, CI gates, production deployments and owner QA records
are outside this change.

## Verification

- Red: the install test with 10 ms delayed storage reads failed with the same empty event list
  as main; the bounded assertion passed with the delay still present.
- Red: typecheck with temporary `@types/chrome@0.3.5` reproduced both Dependabot TS2345 errors.
- Fixed fixtures passed typecheck against 0.3.5; both edited test files passed (75 tests).
  The original manifest and lockfile were restored, and the final checks use locked 0.2.9.
- Lint, workspace typecheck, tests and builds passed. Vitest: 6,433 passed, 39 skipped;
  root Node tests: 58 passed, 1 skipped. Release checks: 117 passed.
- Browser fixtures: 347 passed, 23 skipped, using the ordinary unconfigured build.
- Suppressing the install event made the bounded assertion fail as expected.
- Scoped reuse, quality, efficiency and correctness review found no blocking issues;
  the test storage helper received a readability cleanup. No independent reviewer was dispatched.
- Publishing through a feature PR; main changes only after protected-branch merge.
