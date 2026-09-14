# Reconcile dependency PRs 184–187

Status: implemented; protected merge verification is tracked in [PR #193](https://github.com/ZackC-1/still-app/pull/193).

## Intent

Integrate the reviewed Vitest 5, jest-dom 7, jsdom 30, and pnpm/action-setup 6.1
updates while preserving their original PR heads. These maintain the test and CI
toolchain; they do not publish a new store artifact.

## Requirements

- Preserve each dependency PR's intended version and its Git ancestry.
- Resolve overlapping lockfile entries without broad dependency updates.
- Match the root Node engine and README to jsdom's supported range:
  `^22.22.2 || ^24.15.0 || >=26.0.0`.
- Keep existing test discovery, Svelte DOM matchers, and extension builds working.
- Integrate the current main branch before running the required protected checks.

## Verification

- Review upstream breaking changes against the existing Vitest configuration and
  jest-dom setup; the DOM peer resolves to the already-used testing-library/dom 10.4.1.
- Run frozen install, lint, typecheck, unit tests, builds, and dependency audit on
  the integrated lockfile.
- Require all three CI gates, including both configured and unconfigured browser
  fixture runs, before a normal merge commit to main.
- Confirm all four original heads are ancestors of main after merge; leave store
  artifacts and submissions unchanged.

Detailed command output is local ignored evidence under
`docs/build/release-gates/implementation/pr-cleanup-20260914/`.

Local verification on Node 24.19.0 and pnpm 11.9.0 passed frozen install, lint,
typecheck, all builds, and 788 unit tests (39 existing skips). The integrated audit
reported zero advisories across 404 dependencies. The linked PR records the required
CI results, including Deno and both browser-fixture configurations. Linux skips one
additional macOS-only test, matching the previous CI baseline.
