---
title: Remove superseded repository files
status: in_progress
date: 2026-09-14
owner: codex-personal
branch: chore/repository-file-cleanup
---

# Remove superseded repository files

## Scope and evidence

The owner requested an audit of every repository folder and file, followed by deletion of items
that are no longer useful locally or on GitHub. The baseline is main `bcd76fe` (609 tracked files).
This follows the completed branch cleanup: only main and the independently published gh-pages
remain. Submitted store packages, owner portal edits, and local release evidence stay intact.

CodeGraph context and the tracked-file inventory were consulted first. A TypeScript import scan
resolved relative imports and workspace package exports from build entrypoints, public exports,
configuration, scripts and tests. All 210 JS/TS/Svelte files were accounted for; the one file outside
that traversal is the documented, separately invoked Supabase retention integration test.
No unresolved relative/workspace imports were found. This is file-usage evidence, not proof that
every exported symbol is exercised at runtime.

| Area | Disposition and reason |
|---|---|
| `packages/` | Keep all five workspaces: shared types, core, app webview, Chromium/Firefox and Safari. Keep public exports, test coverage, package assets and signing/CSS scripts. |
| `apps/apple/` | Keep native entrypoints, shared StillKit decisions/tests, Xcode resources/configuration and build/archive/signing scripts. Platform copies are packaging inputs. |
| `supabase/` | Keep deployed function entrypoints, handler tests, historical migrations and disposable-database tests. Dormant billing remains intentionally supported by strategy. |
| `tests/` | Keep fixture, live-site, store-asset and browser harnesses, including manually invoked tests. |
| Root and hidden tracked configuration | Keep workspace/build/lint settings, CI, contribution/security documents, agent instructions and shared vocabulary. |
| `docs/` product/design/solutions/plans | Keep unique decisions, reusable lessons, historical test evidence and pending certification. Age or lack of an inbound hyperlink is not evidence of disuse. |
| Public website | Keep every HTML route, styles/font/license/logo, poster and sharing image. The paid-era MP4 is unused and already absent from gh-pages. |
| Screenshots | Remove superseded paid-era screenshots/compositor and duplicate promo outputs. Keep current functional captures, explicit free-release baselines, canonical promo/IAP files and the live sharing-image URL. |
| Temporary instructions | Remove three explicitly completed agent prompts and the superseded macOS 1.0 build 5 handoff. Keep release records and the solutions that capture its lessons. |
| Ignored local directories | Keep installed dependencies, local configuration, CodeGraph/memory tooling, builds, screenshots, release evidence and the recovery bundle. These are separate from GitHub source. |

The deletion manifest records 73 files (15,491,028 bytes), their hashes and per-file reasons under
ignored `docs/build/release-gates/implementation/file-cleanup-20260914/`. Git history retains the
removed files. Historical references should link to the baseline commit rather than missing paths.

## Implementation

1. Remove only the manifest's verified obsolete paths; preserve historical release/testing records.
2. Narrow `screenshots/source/render.mjs` to brand assets. Write each asset once at its canonical
   location; keep the `iap`, `promo` and `store-promo` filters and reject invalid filters.
3. Update the screenshot manifest, capture guidance and historical references. Do not render over
   committed images or change the live website/store portals.
4. Verify references, retained asset hashes and application-source parity. Exercise the renderer in
   a disposable copy and run the existing store-asset tests plus required protected CI gates.
5. Merge through a PR, fast-forward local main, and remove the temporary cleanup branch.

## Verification

- Passed: exact deletion manifest; application, backend, CI, lockfile and test-source parity;
  all 15 retained documentation raster/font assets unchanged; deployed website inputs unchanged;
  no newly broken local Markdown/HTML links.
- Passed: all four renderer modes in a disposable copy (`iap`, `promo`, `store-promo`, unscoped),
  producing exactly their intended canonical files without duplicate outputs or UI screenshots.
- Passed: six existing Playwright store-asset tests and repository lint.
- Pending: all three PR CI gates (typecheck/unit/build, Deno and configured/unconfigured fixtures).
- Pending: protected merge, local/origin parity and final branch cleanup.

## Recovery

Restore a specific deleted file with `git restore --source=bcd76fe -- <path>` and review that change.
The earlier branch audit also produced a verified local recovery bundle. No history rewrite,
production migration, store replacement or live website deployment is part of this cleanup.
