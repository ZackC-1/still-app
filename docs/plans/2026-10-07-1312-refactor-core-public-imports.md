---
title: Curate shared core source exports for platform consumers
date: 2026-10-07
status: complete
type: refactor
---

# Shared core public imports

The owner selected the shared core import seam alongside reproducible V3 QA builds. The named QA
profiles are already implemented. This bounded change gives Chromium, Firefox, Safari and the Apple
webview explicit package paths for their existing core dependencies.

## Scope and constraints

- Add only consumed, explicit source leaves to `packages/core/package.json`; keep existing exports.
- Mechanically replace production physical `core/src` imports in the three platform packages.
- Preserve type-only imports, dynamic screen loading, source locations and Apple `rootDir: src`.
- Keep `AppleSettings.svelte` out of the shared UI barrel so its global CSS stays app-local.
- Restrict production physical core imports with ESLint; permit tests, tooling and generated data.
- Update the core guide and capture the verified reusable lesson.

No behavior, store/provider configuration, source movement, purchase wiring or redesign is included.
Concurrent redesign changes will need these mechanical import substitutions applied during integration.

## Verification

Take before/after snapshots in the same checkout with `scripts/bundles/identity.mjs` for all four
targets in three profiles: unconfigured defaults, configured public audit placeholders, and coherent
local V3 (`VITE_MODERN_SETTINGS_SYNC_ENABLED=true`, `VITE_APPLE_ATOMIC_SETTINGS=true`). Require every
emitted file to remain byte-identical. Keep baseline snapshots outside the repository.

Run lint, workspace typecheck, full unit tests, full ordinary build and fixtures. Probe the lint
boundary with static imports, dynamic imports, re-exports and type-only imports, and verify the
test/tooling exemption. Check the export map has no wildcard and every leaf points to an existing
file. Record actual outcomes below; this does not certify native/device/provider journeys.

## Evidence

The bounded implementation at base `83e65d51` adds 33 explicit leaves and migrates 60 production
references in 31 files. Existing exports, core source files, the UI barrel and Apple `rootDir: src`
are unchanged. Parent review and integration remain separate from this implementation receipt.

| Check | Observed result |
|---|---|
| Same-checkout bundle identity | All 12 target/profile comparisons byte-identical: 102 ordinary unconfigured files, 99 configured files and 111 coherent local V3 files. |
| Workspace lint and typecheck | Passed; Apple webview and core Svelte checks report zero errors/warnings. |
| Full unit suites | 5,243 passed; 39 existing core skips. Core 4,385, Chromium 534, Safari 266, owner-admin 58. |
| Full ordinary build | Passed, including Firefox. |
| Full browser fixtures | 305 passed; 18 profile-dependent skips, using the existing fixtures project. |
| Restriction negative/positive probe | 54/54 passed across all three platform packages, including Svelte and type/import-expression paths. |
| Mechanical/source/export preservation | 37/37 passed; zero remaining production physical imports. |
| Documentation links and diff check | All eight local links valid; `git diff --check` passed. |

The first sandboxed fixture attempt could not launch Chromium/WebKit on macOS (261 launch failures,
47 passed, 14 skipped and one not run). The same sources passed a 17-case diagnostic and the complete
fixture gate after browser-launch escalation; no source changes were needed to recover.

The private receipt includes the scoped patch, changed-file hashes, snapshots, probe results and logs.
It does not cover native device journeys, account/provider behavior or store readiness. The reusable
lesson is [curated source exports and loading preservation](../solutions/conventions/curate-core-source-exports-without-changing-loading.md).
