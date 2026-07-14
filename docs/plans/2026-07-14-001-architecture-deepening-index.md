# Architecture deepening — context dossiers index (2026-07-14)

Output of an `/improve-codebase-architecture` review run against main at commit `5470713`,
with the stated goal: **pre-release hardening — the app as functional and as efficient as
possible before public release.** Four deepening candidates were selected by the user; each has
a context dossier below written for a planning agent to pick up cold: verified facts with
file:line evidence, invariants that must survive, constraints, design forks with a
recommendation, test inventory, and open questions. The dossiers deliberately stop short of
plans — resolve their open questions (some need the user) before implementing.

A fifth candidate (one shared home for the never-downgrade entitlement rules across the two
session orchestrators) was surfaced and explicitly deferred by the user as too risky before
release. No ADR was recorded — the reason is timing, not a permanent rejection; a post-release
architecture review should re-surface it.

## The dossiers

| Doc | Candidate | Risk | One-line |
|---|---|---|---|
| `2026-07-14-002-hide-css-seam-context.md` | Hide-CSS seam | Low (recommended option is a deletion) | `generateHideCss` is a dead half-seam; formatter triplicated; OTA rule sets silently lose the CSS fast path. Fork: wire the runtime adapter vs delete + ADR. |
| `2026-07-14-003-engine-page-session-context.md` | Engine per-frame hot path | Medium | Service resolution, regex compilation, tier filtering, and URL parsing all recomputed per mutation frame; deepen the Engine with a prepared per-URL session. |
| `2026-07-14-004-extension-entry-factory-context.md` | Extension entry factory | Medium-low | Content entrypoints ~90% duplicated with zero tests; mirror the Extension UI factory pattern. Includes the Safari reconcile-nudge leak (fix immediately, independent of the factory). |
| `2026-07-14-005-session-protocol-registry-context.md` | Session protocol registry | Low (mechanical + tests) | Every popup↔background capability hand-restated in six places, two type-coupled, zero tests; derive from one registry and add the missing seam tests. |

## Bugs surfaced by the review (fix independently, before/alongside any refactor)

1. **Safari reconcile-nudge leak** — `ext-safari/entrypoints/content/index.ts:70-87`: a
   15-second `setInterval` whose id is discarded plus three window/document listeners, all
   outside any teardown path; per-tab native round-trips forever. Details + fix shape in
   dossier 004. iOS battery/IPC cost on the App-Review platform — highest urgency of anything
   in this set.
2. **Apple post-teardown entitlement race (unverified)** — an in-flight
   `SyncService.onSignedIn` reconcile resolving after `signOutEverywhere`
   (`core/src/sync/apple-session.ts:215-224`) may re-fire `onSyncState` with
   `entitled:true, confirmed:true` and re-stamp the App Group; the extension orchestrator's
   `teardownGeneration` guard (`extension-session.ts`) has no Apple equivalent. Needs a
   targeted test to confirm reachability before any fix. (This sits inside deferred candidate
   5's territory — verify the bug narrowly; do not restructure.)

## Recommended sequencing

1. Bug 1 hotfix (independent, small).
2. Dossier 005 (session protocol) — mechanical, adds the missing tests, no runtime behavior
   change intended.
3. Dossier 002, recommended Option B (delete dead seam + single-source the formatter) — small
   deletion + test consolidation.
4. Dossier 004 (entry factory) — after 002 so the factory wraps the settled CSS wiring.
5. Dossier 003 (hot path) — biggest efficiency win, most care needed; lands last against a
   single wired call site and the strengthened test net from 2–4.

All four are independent enough to plan in parallel; the ordering above is about merge
sequencing, not planning. Coordinate `background.ts` edits between 004 and 005 (both touch it).
Line anchors throughout were verified at `5470713`; other PRs are merging concurrently — treat
anchors as search hints, not gospel.
