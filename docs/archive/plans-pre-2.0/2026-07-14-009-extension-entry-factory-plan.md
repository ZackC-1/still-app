# Extension entry factory

Date: 2026-07-14
Status: implementation-ready
Source: `2026-07-14-004-extension-entry-factory-context.md`

## Goal

Concentrate the duplicated extension content-entry wiring and background rule-set refresh setup in
tested core factories while preserving platform-specific behavior as explicit optional injections.

## Decisions

- Keep WXT `defineContentScript` and its statically analyzable manifest configuration in each
  extension entrypoint.
- Evaluate `import.meta.env.FIREFOX` and `import.meta.env.PROD` in the entrypoint, then pass plain
  values into core. This preserves target-specific dead-code elimination and keeps core WXT-free.
- The common content factory owns cache/ruleset sequencing, redirect-dedupe sharing, core script
  construction, and Chromium's immediate reconcile nudge. Safari supplies its lifecycle-bound nudge
  as an optional injection, so it remains native/App-Group-specific by construction.
- Factor backgrounds only through a small rule-set refresher factory; auth/session/App-Group/DNR
  wiring remains platform-specific. This respects ADR-0001's caution against abstracting genuinely
  divergent routing.

## Invariants to pin

1. Early redirect begins before the local rule-set read and shares one dedupe cell with the script.
2. A resolved bundled set selects `manifestCssOwnsHides`; a fetched set does not.
3. Safari invalidation after the read prevents script/nudge startup.
4. Chromium starts the script and immediately fire-and-forget nudges; Safari registers its nudge
   before start and requests reconciliation only after successful start.
5. The shared background refresh factory retains the same endpoint/key fail-safe and reuses one
   configured refresher across cold start and content-script nudges.

## Verification

- Core factory tests execute all content ordering and platform-injection paths.
- Loader tests cover endpoint and refresh configuration.
- Existing Safari nudge teardown tests continue to prove lifecycle cleanup.
- Full lint, typecheck, unit, Chromium/Firefox/Safari build, and Playwright fixtures pass.
