# Still simplification review

Status: item 2 authorized and implemented; verification recorded below. Items 1 and 3 were not authorized.
Owner/harness: Codex.

Reviewed October 22, 2026, on a fresh checkout of `origin/main` at `3d344ce5`.
Branch: `refactor/main-simplification-20261022`.
Workspace: `/private/tmp/still-main-simplification-20261022`.
The separate SEO work was excluded after the owner clarified the scope.

## What we are trying to achieve

Still should reliably remove the unwanted short-form surfaces, preserve the useful parts of the
supported websites, and be easy to enable. Free blocking must work without an account or purchase.
Optional sync and the approved Pro extras must not complicate that basic outcome.

Code earns its place when it delivers one of those outcomes, protects an existing customer's
settings or purchase, or gives us a dependable way to release the product. A shorter implementation
that loses those protections would be a worse product.

My recommendation is two bounded cleanups now and one larger deletion after V3 is established.
I do not recommend a broad rewrite, a new abstraction layer, or more automation.

## Consolidated findings

### 1. Remove the V3 bookkeeping for an analytics notice that no longer appears

**Proposed change:** Remove the V3 storage wrapper that tracks which version of the old analytics
notice a person acknowledged. Remove the extra V3 acknowledgement-version write on Apple as well.
Use the existing storage directly. Leave old stored values alone; no data migration or cleanup
job is needed. Keep the old acknowledgement message accepted and retain the older release's
notice behavior.

**Why:** The owner removed the V3 notice on October 12. V3 always answers that no notice is needed,
but still maintains code and tests for the notice's version history. This is machinery for a
retired interaction. It does not help the remaining Share usage data switch.

**Evidence:**

- [The V3 notice wrapper](../../packages/core/src/analytics/default-on.ts) translates notice keys
  and adds an Apple version write. The rest of the permission and identity code in that file is
  still needed.
- [The browser host](../../packages/ext-chromium/lib/default-on-analytics.ts) installs that wrapper
  while explicitly disabling the notice.
- [The shared host](../../packages/core/src/analytics/extension-host.ts) does not read the notice
  key when the notice is disabled.
- [The decision](../adr/0004-first-party-usage-analytics.md#one-usage-data-control-2026-10-12)
  explicitly keeps the switch as the only V3 control.

**Expected consequence:** No change to current V3 screens, the user's sharing choice, collected
events, or account deletion. Fewer storage translations and fewer obsolete details to maintain.
No measurable speed or download-size improvement is claimed.

**What could go wrong:** An old open page can still send an acknowledgement. Tests deliberately
cover that compatibility today. The proposal changes the obsolete marker-writing side effect;
it is not merely deletion of an unreachable function. We must keep that message successful and
prove that older-release behavior, upgrades, and sharing-off choices still work. Do not remove
native message handlers or the shared notice interface as part of this item.

**Estimated effort and risk:** 2–4 engineering hours including targeted tests and review.
Low to moderate risk because analytics permission handling is nearby. The change should remain
limited to obsolete notice bookkeeping.

**Verification after approval:** Keep the existing no-notice, upgrade, permission, and identity
tests. Replace only assertions whose sole purpose is the retired version marker, retaining an
explicit old-message compatibility assertion. Run both analytics suites, older-release checks,
lint, typecheck, and affected builds. If compatibility needs the wrapper, keep it and report that
result instead of broadening the change.

### 2. Remove conflicting current instructions and clearly retire the old work list

**Proposed change:** Give each current rule one authoritative explanation and link other documents
to it. Correct stale source comments. Mark the July architecture work list as historical, with
links to current implementations and the one explicitly deferred decision. Preserve history and
existing references; no repository-wide file reshuffle is needed.

**Why:** Some of the apparent complexity is contradictory guidance. It can cause the next change
to restore a behavior the owner already removed, or treat a historical identifier as the only
current purchase identifier.

**Evidence:**

- [The V3 release summary](../release/history/v3/README.md) still describes fresh combined
  analytics consent as the current design, while
  [ADR 0004](../adr/0004-first-party-usage-analytics.md) records the later default-on switch and
  removal of the notice.
- [The entitlement comment](../../packages/shared-types/src/entitlement.ts) says the old purchase
  unlocks service blocking and sync. Current product policy says those outcomes are free.
- [The architecture reference](../ARCHITECTURE.md) describes `still_sync` as the immutable internal
  entitlement identifier without explaining the current V3 mapping. The
  [current provider parser](../../supabase/functions/_shared/revenuecat-access.ts) explicitly
  accepts both historical identifiers and `still_pro_v3`. Preserve every identifier and existing
  customer's rights; correct the explanation rather than renaming anything.
- [The July architecture index](2026-07-14-001-architecture-deepening-index.md) still reads like
  upcoming work. Shared content entry construction, prepared engine sessions, and the session
  capability registry now exist in
  [extension-entry.ts](../../packages/core/src/content/extension-entry.ts),
  [engine.ts](../../packages/core/src/rules/engine.ts), and
  [session-messages.ts](../../packages/ext-chromium/lib/session-messages.ts).

**Expected consequence:** Clearer instructions for future work, fewer repeated investigations,
and less chance of reintroducing a paywall or consent prompt. No application behavior changes.

**What could go wrong:** Rewriting historical decisions as though they never existed, or presenting
unverified production status as current fact. Keep dates and history, distinguish shipped 2.x
from V3, and resolve descriptions against accepted decisions and current code. Do not change
product policy, portal configuration, or public legal copy through this cleanup.

**Estimated effort and risk:** 2–4 engineering hours. Low runtime risk; careful factual review is
the main work.

**Verification after approval:** Check each changed claim against its decision and implementation,
check document links, and confirm the diff changes no runtime values. Keep the deferred purchase
architecture decision visible rather than marking the entire July list completed.

### 3. Retire the separate 2.x build path after V3 is stable — defer for now

**Proposed future change:** Once there is an agreed end to building 2.x from main, make V3 the normal
build and delete the old screen selection branches, superseded UI, and duplicate host wiring that
exist solely to produce the earlier release. Use a recorded release commit or maintenance branch
for an older-release fix if needed.

**Why:** Maintaining two generations increases the number of combinations every change must
respect. This is a larger source of ongoing work than isolated helper functions. The clean
solution is eventually to stop maintaining one build generation, rather than add a more general
framework around both.

**Evidence:**

- [Apple's webview entry](../../packages/app-webview/src/main.ts) selects old or modern settings,
  analytics and purchase wiring from build configuration.
- [Safari's popup entry](../../packages/ext-safari/entrypoints/popup/main.ts) retains the original
  screen as both the default build and a fallback.
- [The V3 browser analytics host](../../packages/ext-chromium/lib/default-on-analytics.ts)
  explicitly describes its older counterpart as remaining until 2.x retires.
- Both paid-tier flags remain disabled on this reviewed main. These branches are active release
  support, not proven dead code.

**Expected consequence:** Fewer build modes, simpler entry points, and fewer tests whose only
purpose is preserving the old build. Fresh builds from main would then produce V3 behavior.

**What could go wrong:** An older hotfix could become harder to produce; an upgrade could lose
settings; Safari could lose a useful fallback. Deleting old build code does not justify deleting
old-data readers, migration code, server support for installed clients, historical purchase
mappings, or blocking fallbacks. Those need separate evidence. In particular, the
[modern content entry](../../packages/core/src/content/modern-shipping-entry.ts) still falls back
to the older blocking path when settings cannot establish the modern state. Keep that behavior
until an equally reliable replacement is demonstrated.

**Estimated effort and risk:** Roughly 3–7 engineering days for the UI/build retirement and
cross-platform verification, plus device testing and release scheduling. High risk before the
release transition; uncertain until the exact cutoff and remaining fallback callers are agreed.

**Recommendation:** Do not authorize this as immediate cleanup. Revisit after V3 has shipped,
upgrade behavior is verified, and the older-release maintenance policy is explicit.

## What I would leave alone

| Area challenged | Recommendation and reason |
|---|---|
| Shared blocking engine and thin platform entry points | Keep. The main sharing boundaries already exist. Replacing them would add migration work without an identified user benefit. |
| Account-switch checks, ordered settings writes, retries and delayed-response checks | Keep. These prevent lost choices and one account receiving another account's settings. Their complexity follows from real offline and concurrent use. |
| Apple purchase handling versus browser purchase handling | Keep distinct. Apple can prove a device purchase while signed out; browsers rely on account authority. A universal purchase flow would hide a meaningful difference. |
| Historical purchases and older stored settings | Keep compatibility. Old identifiers and records are customer obligations, not disposable naming mistakes. |
| Analytics identity, permission and deletion protections | Keep. Removing these while keeping analytics would weaken the existing privacy contract. Dropping analytics itself would be a new product decision, not routine cleanup. |
| Rating/share invitations and optional Pro | No removal proposed. They add complexity, but serve explicit approved adoption and commercial goals. This review did not measure their effectiveness. |
| Release approval, environment separation and verification tools | Keep. They prevent publishing a test build or applying a change to the wrong system. I found no basis to remove their protections merely to shorten the workflow. |
| Tests and framework entry points flagged only as unreferenced | Keep unless their use is actually disproved. The October 21 audit already removed confirmed dead code and documented false positives. |
| SEO branch | Outside this review. No source changes made there. |

## Evidence and limits

This was a project-wide architecture and maintenance review, with focused source inspection of
blocking, UI/build selection, analytics, purchase boundaries and release tooling. It was not a
line-by-line review of every file or a live-device certification.

I also read the [October 21 dead-code audit](2026-10-21-007-dead-code-and-test-audit.md), confirmed
its PR was merged in this checkout's history, and avoided repeating its rejected candidates.
The five simplification review lenses were applied in the main session; no review agents ran.

Checks on unchanged main:

- Dependency installation with the frozen lockfile passed.
- `pnpm lint` passed.
- `pnpm typecheck` passed.
- Core default-on analytics: 25 tests passed.
- Browser default-on analytics: 39 tests passed.
- Apple default-on and older-release analytics: 30 tests passed.
- Total targeted baseline: 94 passing tests across four files.

No full test suite, production build, Deno suite, Xcode build, browser journey or physical-device
test was run for this proposal. Those checks must be chosen for the changes actually approved.
Mem0 retrieval was unavailable because its monthly quota was exhausted; this report and repository
evidence hold the review state.

Effort estimates are rough engineering time, including verification, not elapsed-time promises.
The owner requested one consolidated report and authorization before implementation, then authorized
item 2 only. Items 1 and 3 remain proposals.

## Item 2 implementation — October 22, 2026

- Centralized V3 and historical purchase identifiers in `docs/monetization-design.md`, backed by
  `ApplePurchaseCatalog`, the backend provider parser and the October 21 owner decision. Strategy,
  product, architecture, glossary and release references link to that table.
- Replaced obsolete current-checkout and unsigned-only descriptions with links to the current
  architecture and production activation record. Historical procedures remain explicitly labeled.
- Pointed V3 consent guidance to ADR 0004's later decisions and retained the original decision history.
- Marked the July architecture index historical in place, linked current implementations, and
  retained the explicit deferral of cross-platform purchase-rule consolidation.
- Corrected the historical entitlement comment and removed the stale Apple entrypoint narrative.
  No runtime values, purchase identifiers, permissions, public legal pages or external systems changed.

Post-change verification:

- `pnpm lint` and `pnpm typecheck` passed.
- All 160 checked local document links and anchors resolved, with no broken inbound anchors.
- TypeScript token comparisons confirmed identical code before and after both source-comment edits.
- `git diff --check` passed.

After the owner authorized commit and merge, the full local publication checks also passed:

- `pnpm test`: 7,191 passed and 40 skipped.
- `pnpm build`: passed.
- `pnpm exec playwright test --project=fixtures`: 370 passed and 37 skipped.

Work remained in the isolated review worktree; other active sessions' branches and checkouts
were left untouched. Items 1 and 3 remain unimplemented proposals.
