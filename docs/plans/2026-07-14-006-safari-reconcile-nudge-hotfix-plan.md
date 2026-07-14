# Safari reconcile-nudge teardown hotfix

Date: 2026-07-14  
Status: implementation-ready  
Source: `2026-07-14-004-extension-entry-factory-context.md`

## Goal

Stop Safari content-page reconcile polling and activation listeners when WXT invalidates the
content-script context, without changing when a live page requests reconciliation.

## Scope

- Move the Safari nudge lifecycle into a small testable helper in `packages/ext-safari/lib/`.
- Register all timer and event cleanup through the WXT content-script context and stop the core
  content handle on the same invalidation boundary.
- Pin the teardown in the Safari unit suite.

## Invariants

- Preserve the immediate, post-start, 500 ms, focus, pageshow, visibility, and visible-15-second
  nudge schedule for an active content-script context.
- Retain best-effort messaging: a failed background send remains swallowed.
- Do not change the core content engine, manifest CSS ownership, entitlement gating, or redirect
  ordering.

## Verification

1. A focused unit test proves every nudge registration is bound to the lifecycle context and that
   invalidation stops the core script.
2. Run the Safari package test and typecheck suites, then the repository lint/typecheck/test gates
   before the PR is reviewed.
