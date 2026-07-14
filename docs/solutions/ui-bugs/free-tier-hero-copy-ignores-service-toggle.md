---
title: Free-tier hero copy claims Shorts removal without checking the per-service toggle
date: 2026-07-14
category: ui-bugs
track: bug
module: packages/core/src/ui
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "With globalOn=true, entitled=false, services.youtube=false the hero secondary read \"YouTube Shorts are removed…\" while the YouTube row directly beneath it read \"Shorts are showing.\""
  - "The contradiction was visible on every surface that renders the shared core UI (Safari/Chrome/Firefox popup and options, Apple webview)"
  - "Caught pre-merge in PR #96 review (Codex bot + two independent ce-code-review personas); no existing test pinned the state"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [entitlement-copy, free-tier, hero-status, svelte, state-axis, code-review, copy-honesty]
status: active
---

# Free-tier hero copy claims Shorts removal without checking the per-service toggle

## Problem

PR #96 made the hero status line entitlement-aware (`STRINGS.global.onFree` / `onPro` / `offSecondary`), but the free-tier line "YouTube Shorts are removed. Still Pro adds Reels, TikTok, and sync." asserted removal without checking whether the YouTube service row was actually on. Removal truthfully requires `globalOn && services.youtube`, so a free user with Still on but the YouTube row toggled off saw the hero claim removal while Shorts were showing directly underneath.

## Symptoms

- State: `globalOn=true`, `entitled=false`, `services.youtube=false`.
- Hero secondary text: "YouTube Shorts are removed…"
- YouTube service row (same screen): "Shorts are showing."
- The two lines directly contradicted each other.

## What Didn't Work

1. **The PR's original cut — entitlement axis only.** The authoring session scoped status truthfulness to exactly three states — Free, Pro, and global-off — during a broad launch-readiness sweep, effectively conflating "service row off" with "global off"; the per-service toggle was never identified as a fourth axis (session history). The copy's truth claim depended on a state axis the code never inspected — an incomplete state matrix.
2. **Reviewer-proposed "entitlement-pending" gate — refuted.** A review finding proposed gating the free/pro split on an entitlement-hydration "pending" signal (`c.reconciling` / `popupState === 'entitlement-pending'`) to stop a returning-Pro-user upsell flash at startup. Investigation found the mechanism doesn't exist for this purpose: extension hosts never set `reconciling` (only `apple-session.ts` writes it) and hydrate entitlement via `EntitlementCache` with no in-flight flag; on Apple, the flash window spans mount → `supabase.auth.getUser()`, during which `popupState` reads `'signed-out'` — indistinguishable from a real signed-out free user. A real fix needs a new tri-state entitlement-hydration signal threaded through `extension-setup.ts`, `app-webview/main.ts`, and the Safari wiring — deferred as a multi-host design decision rather than patched superficially. Nothing tracks this yet.

## Solution

Commit `57ebb8c` (merged to `main` at `b8bdf9b`).

`packages/core/src/ui/App.svelte` — gate the free line on the YouTube row's own state, with the reasoning left in a comment:

```svelte
<p>
  <!-- The free line claims "Shorts are removed", which is only true while the YouTube row —
       the free tier's one service — is itself on; row-off gets the truthful sibling line.
       Pro needs no gate: "on enabled sites" already hedges per-service state. -->
  {c.settings.globalOn
    ? c.entitled
      ? STRINGS.global.onPro
      : c.settings.services.youtube
        ? STRINGS.global.onFree
        : STRINGS.global.onFreeYoutubeOff
    : STRINGS.global.offSecondary}
</p>
```

`packages/core/src/ui/strings.ts` — new sibling string mirroring the row's own off voice:

```ts
onFree: "YouTube Shorts are removed. Still Pro adds Reels, TikTok, and sync.",
// Free user with the YouTube row itself toggled off: Still is on but removing nothing, so the
// hero must not claim removal (it would contradict the row, PR #96 review). Mirrors the row's
// own off voice ("Shorts are showing.") and keeps the Pro line.
onFreeYoutubeOff:
  "YouTube Shorts are showing. Still Pro adds Reels, TikTok, and sync.",
onPro: "Short-form is removed on enabled sites.",
```

`packages/core/src/ui/__tests__/App.test.ts` — regression test plus a `services` override on the test `controller()` helper:

```ts
it("free user with the YouTube row off does not claim Shorts are removed", () => {
  render(App, {
    props: { controller: controller({ services: { youtube: false } }) },
  });
  expect(screen.getByText(STRINGS.global.onFreeYoutubeOff)).toBeTruthy();
  expect(screen.queryByText(STRINGS.global.onFree)).toBeNull();
});
```

`onPro` needed no gate — "Short-form is removed on enabled sites." hedges the per-service axis in phrasing rather than branching on it, so it stays true regardless of which Pro services are toggled.

## Why This Works

Root cause: a copy string asserted a claim ("Shorts are removed") conditioned on fewer state axes than the claim actually depends on. The bug wasn't the entitlement branch itself — "removed" is a function of `globalOn && service-on`, and the code branched on `globalOn` and `entitled` while leaving `services.youtube` unbranched for the free case.

There are exactly two valid fix shapes for this class of bug, and the hero now demonstrates both side by side:

1. **Branch on the axis, with a truthful sibling line** — what `onFree`/`onFreeYoutubeOff` do. Use when the two states genuinely need different copy.
2. **Hedge the claim in phrasing so it stays true across the axis** — what `onPro` does ("on enabled sites" absorbs per-service variation without a branch). Use when one line can honestly cover all values of the axis.

Picking the wrong shape (or, as here, doing neither) leaves a claim that's only accidentally true in the state you tested.

## Prevention

- **When copy asserts state, enumerate the full state matrix in tests, not just the axes you branched on.** The hero now has four pinned states in `App.test.ts`: free+YouTube-on (`onFree`), Pro (`onPro`), global-off (`offSecondary`), and free+YouTube-off (`onFreeYoutubeOff` present AND `onFree` absent). The last one is the regression guard the original PR lacked.
- **Before adding a conditional branch for a copy string, ask whether phrasing can hedge the axis instead** (`onPro`'s "on enabled sites" pattern) — fewer branches, fewer states to get wrong, no sibling case to forget.
- **When a reviewer proposes a mechanism (a flag, a signal, a state field), verify it actually fires in the claimed window before adopting it.** Here, `c.reconciling` / `popupState === 'entitlement-pending'` sounded plausible but tracing the hosts showed the signal never distinguishes the window in question; adopting it blindly would have wired a fix around a silent no-op. Confirming first correctly reclassified the ask as a multi-host design change.
- **Keep per-OS/per-platform copy decisions in a testable pure function**, per [testable-swift-decision-logic-via-stillkit](../architecture-patterns/testable-swift-decision-logic-via-stillkit.md). The same PR cycle (commit `6be13e0`) applied it to onboarding: `OnboardingCopy.enableSteps(iOS18OrLater:)` and `macOSEnableSteps` now live in StillKit with pinning tests, while the app-target view (which no CI test can reach) only resolves `#available(iOS 18.0, *)` and calls in.

## Related Issues

- [codify-cross-platform-visual-contract-in-tests](../conventions/codify-cross-platform-visual-contract-in-tests.md) — sibling test-pinning philosophy (contract-as-test), applied there to cross-platform files rather than a state-conditioned copy string; same `__tests__` directory.
- [testable-swift-decision-logic-via-stillkit](../architecture-patterns/testable-swift-decision-logic-via-stillkit.md) — same-cycle sibling (commit `6be13e0`, PR #96) applying the extract-to-StillKit pattern to per-OS onboarding copy.
- [mirror-fixes-across-parallel-paths](../conventions/mirror-fixes-across-parallel-paths.md) — related-but-distinct failure shape: that doc is duplicated code paths drifting apart; this doc is a single implementation under-conditioned on a state axis.
- PR #96 (https://github.com/ZackC-1/still-app/pull/96) — the fix commits `57ebb8c` (hero copy) and `6be13e0` (OnboardingCopy) landed during its review cycle.
- Deferred follow-up with no tracking issue yet: tri-state entitlement-hydration signal to prevent the returning-Pro upsell flash (see What Didn't Work #2).
