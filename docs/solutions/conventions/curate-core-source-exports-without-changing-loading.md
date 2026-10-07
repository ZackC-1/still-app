---
title: Curate core source exports while preserving lazy screens and bundle bytes
category: conventions
track: knowledge
problem_type: maintainability
module: packages/core
applies_when: Replacing physical cross-package source imports in platform shells
date: 2026-10-07
status: active
tags: [exports, bundles, svelte, architecture]
---

## Problem and cause

Platform shells imported shared UI, invitation, rules and content modules using relative
`core/src` paths. The Apple webview used `node_modules/@still/core/src` paths to stay inside its
TypeScript `rootDir`. Both forms tied consumers to the physical package layout and bypassed the
package's deliberately limited interface.

A single enlarged UI barrel would erase a different boundary: optional screens load lazily, and
`AppleSettings.svelte` imports global CSS that must stay in the Apple app bundle. Exporting every
source file with a wildcard would expose internal fixtures and helpers without review.

## Solution

Add explicit, consumed source leaves to the [core export map](../../../packages/core/package.json).
Keep existing subsystem barrels and source file locations. Migrate only the import specifiers;
preserve `import type`, dynamic `import()` and existing feature selection. A leaf export names a
module without loading it eagerly. Keep AppleSettings out of `@still/core/ui` and import its
dedicated leaf only from the app host. Package resolution lets Apple retain `rootDir: src`.

Apply ESLint's `no-restricted-imports` to platform production code for static imports and re-exports.
Use `no-restricted-syntax` for `ImportExpression` and `TSImportType`, which the static rule does not
cover. The current TypeScript parser places an import type's string under `source.value`, not
`argument.value`; probe the actual parser shape before claiming type coverage. Use `\\u002F` in
selector regexes so slashes do not terminate esquery's regex syntax. Exempt tests and tooling, which
need physical fixture inspection and generation inputs. Allow public `@still/core/rules` leaves.

## Verification and limits

The bounded [plan](../../plans/2026-10-07-1312-refactor-core-public-imports.md) migrated 60 references
in 31 production files through 33 new explicit leaves. An inverse mechanical check compared every
consumer against its original source after only the expected specifier replacement. Existing
exports, the shared UI barrel and Apple's TypeScript root stayed unchanged; every export target
exists and the map has no wildcard.

Use [bundle identity](../../../scripts/bundles/identity.mjs) before and after in the **same checkout**.
Svelte's scoped CSS hash depends on the component file path; cross-worktree snapshots cannot prove
identity. All four targets stayed byte-identical in ordinary unconfigured (102 files), ordinary
configured public audit placeholders (99 files), and coherent local V3 (111 files) profiles.
The local V3 profile sets both modern settings and Apple atomic flags.

Workspace lint, typecheck, full ordinary builds and all 5,243 unit cases passed (39 pre-existing
core skips). A private 54-case lint probe covered three production surfaces, including Svelte,
static/type imports, dynamic imports, re-exports, physical rules, public leaves and test/tooling
exemptions. Full browser fixtures passed 305 cases with 18 profile-dependent skips; macOS required
browser-launch escalation after the sandbox aborted browser startup. These checks cover import resolution
and output preservation; native devices, live account journeys and providers require their own
verification.

## Prevention

Add source leaves when a production consumer needs them; do not expose a whole folder for convenience.
Keep optional screen imports lazy and app-only global CSS outside shared barrels. Run the boundary's
negative probes after parser upgrades and compare all relevant bundle profiles before treating an
import refactor as behavior-preserving.
