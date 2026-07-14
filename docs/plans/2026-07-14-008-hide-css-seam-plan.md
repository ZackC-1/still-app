# Hide-CSS seam (Option B)

Date: 2026-07-14
Status: implementation-ready
Source: `2026-07-14-002-hide-css-seam-context.md`

## Goal

Remove the unused runtime hide-CSS formatter and make the shared build generator the sole formatter,
without changing the bundled-CSS fast path or fetched-rule-set fallback behavior.

## Decisions

- Use the ratified Option B: no runtime CSS injection for fetched rule sets.
- Packaged CSS owns hides only for the exact bundled seed. A fetched/cached set keeps the JS hide
  sweep; stale packaged selectors can therefore over-hide until a store release removes them.
- Preserve ADR-0001: this change does not alter the hand-routed native bridge.

## Implementation

1. Delete `generateHideCss`, its barrel export, and its engine-only tests.
2. Keep `gen-content-css.mjs` as the sole formatter and change the stylesheet drift test to run it
   against a temporary output directory rather than mirroring its bucketing logic.
3. Add an orchestrator test that proves `manifestCssOwnsHides: true` selects remove-only work while
   false/omitted applies hide surfaces through JS.
4. Correct loader/runbook/monetization wording and record the accepted CSS ownership limitation in
   a new ADR.

## Verification

- Core content and engine tests prove both manifest-CSS branches.
- Generated Chromium and Safari stylesheets byte-match output from the shared generator.
- Full lint, typecheck, unit, three-target build, and Playwright fixture gates remain green.
