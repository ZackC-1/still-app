---
title: Organize repository navigation and preserve project knowledge
status: implemented
date: 2026-09-14
owner: codex-personal
branch: docs/repository-organization
---

# Organize repository navigation and preserve project knowledge

## Outcome

Apply useful organization patterns from established browser-extension repositories without losing
functionality, information or release evidence. Baseline: main `ccee37c`, after merged PR #196.

The [research](../research/2026-09-14-extension-repository-layout.md) compares uBlock Origin,
Refined GitHub, Dark Reader, Bitwarden, Ghostery and WXT guidance. Current code already separates
shared behavior, browser shells, the native Apple host, backend and tests. Preserve those paths.

## Work

- Add nine component README guides and make development instructions easy to find at the root.
- Consolidate all implementation vocabulary into `CONCEPTS.md`; retain `CONTEXT.md` as a tool/link
  compatibility pointer. Preserve the original definitions and clarify their scope.
- Move two dated research notes into `docs/research/` and the historical launch log into
  `docs/archive/release-sessions/`. Keep their content and update relative references.
- Complete the docs index and placement rules. Keep release runbooks, plans, historical tests,
  public URLs, configuration and submitted artifacts intact.
- Verify document preservation, local links, command names, runtime/assets/lockfile parity and CI;
  merge through a PR and synchronize local main afterward.

## Evidence and recovery

The source audit in [the preceding cleanup](2026-09-14-repository-file-cleanup.md) accounts for
the runtime files; this pass makes no code changes. The earlier local W6 proposal was used as
background and its recommendations rechecked against current state.

Local verification passed: all 403 non-Markdown baseline files are byte-identical; both moved
research notes are byte-identical; the moved launch record differs only in five relative link
destinations. All 15 former CONTEXT definitions are preserved, and the original CONCEPTS paragraphs
remain with explicit scope/provenance qualifications. The old `#surface` anchor is retained.
No newly broken local Markdown links were found, and 13 documented package commands match their
package scripts. Git whitespace validation passed.

Full CI and the protected merge will be linked through the PR. Historical files remain in Git and
the moved files remain in the current tree. Restore a specific old path from `ccee37c` if needed;
do not replace current source or store packages with an older snapshot.
