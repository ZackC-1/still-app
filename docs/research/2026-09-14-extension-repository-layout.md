# Browser-extension repository organization

Researched September 14, 2026 for the owner-requested organization pass. This refreshes the earlier
local W6 proposal against the current repository after PR #196's obsolete-file cleanup.

## Reference sample

The sample combines widely starred extension projects with comparable multi-app and Safari hosts.
GitHub stars are a visibility signal, not install counts or a complete popularity ranking. Counts
and directories below were read from the GitHub API on the research date; they will change.

| Repository | Stars | Observed organization | Application to Still |
|---|---:|---|---|
| [uBlock Origin](https://github.com/gorhill/uBlock) | 67,835 | Shared `src/`, browser adapters in `platform/`, build helpers in `tools/`. | Keep shared behavior in core and browser wiring in the extension packages. This is an architectural reference, not a recommendation to copy its browser manifest policy. |
| [Refined GitHub](https://github.com/refined-github/refined-github) | 32,158 | `source/` separates features, helpers and components; `test/`, `build/` and `safari/` have distinct roles. | Keep tests/build/native concerns visibly distinct and explain their entrypoints. |
| [Dark Reader](https://github.com/darkreader/darkreader) | 22,356 | Shared `src/` with browser manifests; separate `tasks/` and `tests/`. | Preserve the shared runtime and separate verification/build tooling. |
| [Bitwarden clients](https://github.com/bitwarden/clients) | 13,784 | `apps/` and shared `libs/`; `apps/browser/README.md` introduces that component. | Add concise guides inside each major Still component. A different workspace manager is unnecessary. |
| [Ghostery](https://github.com/ghostery/ghostery-extension) | 1,740 | Shared extension `src/` beside `xcode/`, whose shared/iOS/macOS folders follow Apple's generated structure. | Preserve Still's native Xcode layout and document the web-resource boundary. |

[WXT's project-structure documentation](https://wxt.dev/guide/essentials/project-structure)
specifies `entrypoints/` and `public/` and identifies generated working/output directories.
Still's extension packages already follow those conventions. Its configured build output uses
`dist/`; changing the framework defaults is not required to make that boundary clear.

## Decisions

These are adaptations to Still's needs, inferred from the observed patterns rather than a universal
folder standard:

1. Keep `packages/`, `apps/apple/`, `supabase/` and `tests/`. Their boundaries reflect real consumers
   and platform requirements; renaming them would add Xcode/build/import churn without improving
   locality. Preserve public website paths because the publishing branch and store URLs use them.
2. Add a short README at the five workspaces and the Apple, backend, tests and ADR directories.
   Explain purpose, input/output, safe local commands and the next authoritative guide.
3. Put development instructions early in the root README and include the previously omitted
   app-webview package in the repository map. Keep product, trust and release information.
4. Make `CONCEPTS.md` the single glossary. Preserve all former `CONTEXT.md` definitions there and
   keep a small compatibility pointer for existing tools/links. Distinguish a supported browser
   surface from an authored rule-set Surface.
5. Keep current runbooks under `docs/release/`, dated external research under `docs/research/`,
   and the historical launch log under `docs/archive/release-sessions/`. Preserve document contents
   and repair relative links after moving them. Unique plans and test evidence remain available.
6. Use `docs/README.md` as the document map, with explicit placement rules for future files.
   Maintain existing configuration names, CI, licenses, security files and agent entrypoints.

## Changes deliberately avoided

No new workspace framework, source-directory rename, website deployment mechanism, automated store
submission or test reorganization. No runtime code, package versions or generated app payloads
change. This pass organizes developer navigation and retained knowledge; the submitted release
continues through its existing store process.

Implementation and verification: [organization plan](../plans/2026-09-14-repository-organization.md).
