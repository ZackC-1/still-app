---
title: "Canonical docs refresh: interview program + unified update plan"
status: draft
date: 2026-10-06
owner: "tbd"
branch: "tbd"
---

# Canonical docs refresh: interview program + unified update plan

> Status: **Draft** — produced for owner approval. No rewrites, deletions, or pushes happen until approved.

## Goal

Unify the canonical files around the Still V3 strategy and product decisions so future builds reference one consistent story, organize build plans per release, free space by removing stale material, and hold the same result locally and on GitHub.

## Success Criteria

- `STRATEGY.md`, `CONCEPTS.md`, `AGENTS.md`, `CLAUDE.md`, `docs/README.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/CONNECTIONS.md`, `docs/MEMORY.md`, `docs/SHARED-BRAIN.md`, and the root `README.md` agree with the V3 decisions; lower documents no longer contradict the strategy (per the `STRATEGY.md` decision hierarchy).
- How agents use internal vs. outside memory (Mem0) is stated explicitly and verified, not assumed.
- Build plans are organized in one per-release folder going forward.
- Every archival/deletion is listed in a deletion log; nothing disappears silently (Git history retains removed material).
- Local `main` and GitHub `origin/main` match after the work; the interview script is committed and reusable.

## Approach

Two phases with an approval gate between them. Phase 1 builds a small committed interview script that only produces plans (no rewrites or deletions itself). Phase 2 executes the refresh the script planned, after the owner approves the scope contract. Key finding shaping this plan: the V3 authority (`docs/build/v3/`: `BUILD-PLAN.md`, `DECISION-LOG.md` D001–D490, `STATE.md`, `COMMERCIAL-DECISION-PACKAGE.md`, design handoffs, plus handoff `docs/handoffs/build/2026-10-01-codex-personal-v3-homework-pause.md`) is Git-ignored and local-only today — a curated, scrubbed copy must be promoted into committed docs before GitHub can share it.

## Steps

### 1. Build the plain-English interview script (plan-only)

- Change: add `scripts/docs-refresh-interview.mjs` that asks terminal questions in plain English and writes/updates a dated plan in `docs/plans/`; it never edits or deletes docs itself.
- Files/symbols: `scripts/docs-refresh-interview.mjs` (new, committed so it works identically locally and on GitHub).
- Dependencies: none.

### 2. Promote a curated V3 record into committed docs

- Change: copy the publishable V3 substance (commercial decisions, strategy/product deltas, build scope) from local-only `docs/build/v3/` into a committed per-release folder; scrub portal observations and anything private. Raw `docs/build/v3/` stays local.
- Files/symbols: new per-release folders (v1, v2, v3, …) each holding that release's plans, build plans, and screenshots; actual release files organized separately by version alongside them — plus inbound-link updates.
- Dependencies: step 1 not required; owner approves folder location and scrub rule first.

### 3. Refresh the canonical files from V3

- Change: rewrite the in-scope canonical files so they reflect V3 strategy/product; fix contradictions top-down per the strategy decision hierarchy.
- Files/symbols: `STRATEGY.md`, `CONCEPTS.md`, `AGENTS.md`, `CLAUDE.md`, `docs/README.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/CONNECTIONS.md`, `docs/MEMORY.md`, `docs/SHARED-BRAIN.md`, root `README.md`.
- Dependencies: step 2 (needs the committed V3 record as its source).

### 4. Verify and document the Mem0 truth

- Change: confirm what actually depends on Mem0 (established: the Still app does not use Mem0 — `docs/MEMORY.md` states this is developer tooling only) and write the verified agent memory workflow explicitly into the refreshed `MEMORY.md`/`SHARED-BRAIN.md`/`AGENTS.md`.
- Files/symbols: same memory docs as step 3.
- Dependencies: step 3.

### 5. Reorganize and free space

- Change: move stale plans (~56 in `docs/plans/`), finished handoffs, and superseded material into `docs/archive/` with a dated log — archive only, no deletions; update inbound links in the same change.
- Files/symbols: `docs/plans/`, `docs/handoffs/`, `docs/archive/`, plus a deletion log inside the execution plan.
- Dependencies: steps 2–3 (so current truth is preserved before old material moves).

### 6. Land locally and on GitHub identically

- Change: branch, commit in scoped units, push, verify `main` matches `origin/main`.
- Files/symbols: none beyond steps 1–5.
- Dependencies: steps 1–5.

## Validation Plan

- Script check: run the interview script once; confirm it produces/updates a dated plan file and changes nothing else (`git status --short --branch` shows exactly one new file).
- Docs check: every moved document keeps working inbound links (update links in the same change per `docs/README.md` conventions); indexes (`docs/README.md`, `docs/plans/README.md` if present) point at new locations.
- Space check: file inventory before/after (counts in `docs/plans/`, `docs/handoffs/`, `docs/archive/`) plus deletion log review.
- Parity check: after push, local `main` equals `origin/main` and the per-release folder is visible on GitHub.
- Highest-risk validation: step 2 scrub review — no credentials, customer rows, private contact details, or raw portal captures enter committed docs (per `docs/MEMORY.md` privacy boundaries).

## Risks and recovery

| Risk | Prevention | Recovery |
|---|---|---|
| Publishing private V3 homework to GitHub | Scrub review as the highest-risk gate; raw `docs/build/v3/` never committed | Remove in a follow-up commit; Git history note + rotate anything credential-like |
| Deleting material a future build needs | Delete-vs-archive rule decided before step 5; explicit deletion log | Recover from Git history |
| Reintroducing doc contradictions | Fix top-down per strategy hierarchy; one owner-approved scope contract | Follow-up correction pass against V3 record |

## Scope contract (proposed — needs your explicit approval)

- **In scope:** interview script (`scripts/docs-refresh-interview.mjs`); per-release folders for plans, build plans, and screenshots (v1, v2, v3, …); separately organized per-release folders for actual release files; canonical-file refresh from V3; Mem0 truth verification; archival reorganization with a log; commit + push so local and GitHub match.
- **Out of scope:** runtime code changes beyond the interview script; store/portal submissions; publishing raw `docs/build/v3/` or `release-builds/` contents (both stay Git-ignored and local-only).
- **Done means:** canonical files agree with V3; per-release folders exist with plans, build plans, screenshots, and release files organized by version; stale material archived with a log; local `main` equals `origin/main`; interview script committed and runnable.
- **Rule:** archive, never delete (owner decision 2026-10-06). Deletion log still records every move.
- **Note:** release files currently live in Git-ignored `release-builds/` (2.0.0, 2.1.0, 2.1.1 per version, never committed). Organizing them per version happens locally; GitHub holds the docs-side per-release folders, not the binaries.

## Open Questions

None remaining — all three answered 2026-10-06. Scope contract above awaits your explicit approval; approval authorizes planning only, not execution.

## Decision log

| Date | Decision | Reason |
|---|---|---|
| 2026-10-06 | Canonical list + memory docs in scope | Owner confirmed; agents must know internal vs. outside memory use |
| 2026-10-06 | Still V3 build plans are the authority; per-release folder wanted | Owner: V3 changed strategy and product significantly |
| 2026-10-06 | V3 authority found in Git-ignored `docs/build/v3/`; screen images located | Verified by read: `BUILD-PLAN.md`, `DECISION-LOG.md`, `STATE.md`, handoff; images in `build/v3/.../handoff/`, `docs/release/screenshots/store-ready/`, `source/v3/` |
| 2026-10-06 | Interview script produces the plan for approval first; no self-execution | Owner: "produce the plan for my approval first" |
| 2026-10-06 | Archive rather than delete | Owner decision on open Q1 |
| 2026-10-06 | Per-release folders hold plans + build plans + screenshots; actual release files organized separately by version (v1, v2, v3) | Owner decision on open Q2; read "v2 … then v2" as v1/v2/v3 |
| 2026-10-06 | V3 publish boundary confirmed: publishable substance after scrub; portal/customer/raw material stays local | Owner "yes this is correct" on open Q3 |
| 2026-10-06 | Scope contract approved; Step 1 built and verified (`scripts/docs-refresh-interview.mjs`, syntax-checked, trial run to /tmp produced correct plan, repo shows only intended new files) | Owner "proceed"; verification observed this session |
| 2026-10-06 | Step 1 committed as c5450424 on branch `docs/v3-refresh-plan-and-interview` (script + plan only; not pushed) | Owner "commit this"; 2 files, 250 insertions |
| 2026-10-06 | Step 3 complete, uncommitted: all 11 canonical files refreshed (STRATEGY/PRODUCT/ARCHITECTURE core rewrites + 8 lighter touches); stale-phrase sweep clean (1 false positive on new wording); diff 106+/45- across 12 files | Verified this session; awaiting review/commit decision |
| 2026-10-06 | Step 2+3 committed as c130b972 (15 files, not pushed) | Owner "commit the updates" |
| 2026-10-06 | Step 5 archival pass, uncommitted: 14 superseded Jun–Jul plans moved to `docs/archive/plans-pre-2.0/` with `_MOVED.md` log; 9 link-referenced plans kept in place; 6 inbound links updated in same change; zero dangling refs verified | Archive-only rule; left uncommitted for review |
| 2026-10-06 | Step 2 built and verified: `docs/release/history/v1|v2|v3/README.md` — curated V3 record (tier matrix, $9.99 lifetime, 7-day refund, contract deltas, design gates, raw-record pointers), all 11 relative links resolved, scrub clean (one false-positive word match) | Verified this session; left uncommitted for review |
