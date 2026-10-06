# Engine page session

Date: 2026-07-14
Status: implementation-ready
Source: `2026-07-14-003-engine-page-session-context.md`

## Goal

Prepare immutable rule-set work once per document and cache per-page decisions so content-script
mutation frames avoid repeated URL parsing, service resolution, regex compilation, and tier
filtering while retaining the existing whole-document DOM sweep semantics.

## Decisions

- Add a pure, jsdom-testable engine page session; keep `evaluate`, `applyDom`, and `applyRemovals`
  as compatible wrappers.
- Cache by URL string, settings snapshot identity, and entitlement boolean. Invalid selectors remain
  isolated per selector, and mutation-scoped DOM application remains explicitly out of scope.
- Wire the content orchestrator to one session per resolved rule set and reuse its parsed `URL`
  until `location.href` changes; preserve hydration, redirect dedupe, placeholder, and
  manifest-CSS behavior.

## Test scenarios

- Repeated same URL/settings/entitlement calls reuse the prepared decision and service work.
- Repeated content reapplications on an unchanged location reuse the parsed `URL`; a navigation
  creates a new one.
- URL, settings snapshot, and entitlement changes invalidate the cached result.
- Existing decision/action matrices, cached rule-set hide path, and manifest CSS removal-only path
  continue to produce their current DOM outcomes.

## Verification

- Focused engine and content tests first, then full lint, typecheck, unit, all extension builds,
  fixture Playwright, review, CI, and merge.
