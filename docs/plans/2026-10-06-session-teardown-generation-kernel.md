# Session teardown-generation kernel

Status: completed 2026-10-06 (all units done, CONCEPTS.md term landed post docs-refresh).
Verification: full `@still/core` suite 167 files / 4365 tests passed (incl. new
teardown-generation.test.ts and unmodified teardown-parity.test.ts);
`svelte-check` 0 errors; eslint clean on all touched files (repo-wide `pnpm lint`
failures are pre-existing, confined to checked-in `release-builds/2.1.0` minified
artifacts). Work left uncommitted on `docs/v3-refresh-plan-and-interview`.
Date: 2026-10-06. Branch: `docs/v3-refresh-plan-and-interview`.
Grill decisions (user, 2026-10-06): shared kernel with both orchestrators kept; the
sign-out ordering difference is drift; minimal kernel (counter only, hosts keep gate
conditions). Name approved: **Teardown generation**.

## Goal

Extract the torn-teardown generation guard duplicated in
`packages/core/src/sync/apple-session.ts` (`let teardownGeneration`, 11 use sites) and
`packages/core/src/sync/extension-session.ts` (`let teardownGeneration`, 8 use sites)
into one shared kernel module, and normalize the two sign-out internals to the same
order: invalidate in-flight work → best-effort remote/native resets → unconditional
local teardown → resolve without throwing. No behavior change at any caller seam.

## Success Criteria

- One kernel module owns bump/capture/compare; no `let teardownGeneration` locals
  remain in `packages/core/src/sync/`.
- `teardown-parity.test.ts` passes UNCHANGED — it already pins the unified contract
  (voluntary sign-out lands the local purge even when remote rejects, without
  throwing; failed delete leaves the session intact).
- `apple-session.test.ts`, `extension-session.test.ts`, sync-lifecycle suites, and
  controller suites pass; `pnpm lint` and typecheck clean.
- `CONCEPTS.md` gains the "Teardown generation" term (deferred — see Risks).

## Approach

Minimal kernel per the approved grill: the kernel owns only the counter. Host gate
conditions stay in their hosts verbatim — Apple's `publishStatus` serialization plus
`activeSessionGeneration`/`activeSessionUserId` checks (`apple-session.ts:128-131,`
`240-249`); the extension's F2 identity recheck (`extension-session.ts:352-353`),
`accountStatusTeardowns` display guard, and `nudgeInFlight` single-flight.

Normalization evidence (all read 2026-10-06): the unified contract is already pinned
at the harness level by `teardown-parity.test.ts:281-305`. The drift is internal
only — Apple runs native reset then a throwing `sync.signOut()`
(`apple-session.ts:451-460`), absorption living in `controller.signOut()`
(`controller.svelte.ts:1406-1419`, never throws, always clears local state); the
extension runs a caught `sync.signOut()` then its purge and never throws
(`extension-session.ts:485-500`). The recommended direction is Apple's
`signOutEverywhere` absorbing the `sync.signOut()` failure itself (extension +
controller doctrine); a controller absorbing a non-throw is a no-op, and no
`apple-session.test.ts` case pins `signOutEverywhere` rejecting on sync failure
(throw pins there cover only `deleteAccountEverywhere`, server-first:
`apple-session.test.ts:181,421`). Delete paths stay untouched.

Out of scope: receipt/attach (Apple-only), checkout/nudge/OTP slots
(extension-only), resume semantics, 30-day TTL/install-generation authorities
(ADR 0003 consequence 5 forbids folding those into one gate), and the other four
shared behaviors (voluntary-vs-involuntary, server-first delete, never-throw at UI,
identity preservation) remain documented conventions, future kernel candidates.

## Steps

1. New `packages/core/src/sync/teardown-generation.ts`: `createTeardownGeneration()`
   returning bump/capture/isCurrent over a closed counter; zero dependencies.
   Export the factory and handle type from `packages/core/src/sync/index.ts`.
2. Rewire `apple-session.ts` (11 sites) and `extension-session.ts` (8 sites) to the
   kernel. Mechanical: `++`/`+= 1` → bump; pre-await reads → capture; post-await
   comparisons → isCurrent. Keep every host gate condition verbatim.
3. New `packages/core/src/sync/__tests__/teardown-generation.test.ts`: bump
   invalidates prior captures; isCurrent true with no bump; interleaved spans from
   two captures stay independent.
4. Normalize `signOutEverywhere` (`apple-session.ts:441-460`): wrap
   `await sync.signOut()` best-effort (proceed regardless, as the extension does),
   never reject. `deleteAccountEverywhere` untouched (server-first throw pinned).
5. Docs, after the active docs-refresh session lands: add the CONCEPTS.md term
   (exact text below), then retire this plan file per `docs/plans/README.md`.

## Validation Plan

- `pnpm --filter @still/core test -- src/sync` — all sync suites green, with
  `teardown-parity.test.ts` passing with zero modifications (highest-risk check:
  it is the contract pin for both units of this plan).
- `pnpm --filter @still/core test -- src/ui/__tests__/controller.test.ts` —
  controller absorption paths unaffected.
- `pnpm --filter @still/core typecheck` and root `pnpm lint` clean.
- Manual: none required; all touched behavior is covered by the suites above.

## Risks / Open Questions

- **Docs-refresh collision.** Another agent session is updating project documentation
  on this branch (`STRATEGY.md` and `docs/plans/2026-10-06-docs-refresh-interview-plan.md`
  are dirty). Do NOT edit `CONCEPTS.md` until that session lands; coordinate, then
  add this exact term under Implementation vocabulary:
  `### Teardown generation — the counter marking which sign-in generation is
  current. Bumped on every voluntary teardown or identity switch; async work
  captured before a network wait is discarded when the generation moved. Shared by
  the Apple session orchestrator and the Extension session orchestrator; each
  host's own gate conditions stay in its host.`
- **Scope creep into the other four behaviors.** If the rewire tempts folding in
  voluntary-vs-involuntary or identity preservation, stop: those are explicitly
  deferred to a future candidate.
- Open questions: none — all material facts verified in source this run.
