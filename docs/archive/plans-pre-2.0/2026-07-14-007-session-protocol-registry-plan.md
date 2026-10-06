# Session protocol registry

Date: 2026-07-14
Status: implementation-ready
Source: `2026-07-14-005-session-protocol-registry-context.md`

## Goal

Make the Chromium extension popup-to-background session protocol exhaustive from one capability
registry without changing its runtime outcome vocabulary or fail-safe behavior.

## Decisions

- Keep `restore` as a distinct wire action. It is intentionally an alias of reconcile at the
  session layer, while its caller maps outcomes to restore-specific controller actions.
- Keep silent unavailable degradation for an unknown action, but reject it at the request guard so
  untrusted senders cannot reach a non-existent dispatch arm.
- Keep privileged sender validation at the extension boundary, factored into a pure helper only so
  it can be executed in tests. Content-script reconcile remains a separate low-privilege message.

## Implementation

1. Declare every action once with its payload-shaped handler and unavailable response. Derive the
   request union, action union, response map, unavailable lookup, and exhaustive dispatcher from
   that registry.
2. Move dispatch and extension-origin sender validation into the testable protocol module; keep
   the background as thin listener wiring with `sendResponse` plus `return true` unchanged.
3. Make purchase wiring accept an injected sender internally so tests pin the delete, reconcile,
   and restore translations without changing the production injection gate.

## Verification

- Every action round-trips through the dispatcher to the expected session method and result.
- Null sessions return each registry-owned unavailable response; unknown/malformed actions reject
  at validation.
- Popup/options and embedded-options senders pass validation; page/content-script senders fail.
- Translation pins cover signed-out -> auth-required, delete failure throwing the shared message,
  and restore outcome-to-controller mapping.
- Preserve all existing unit, lint, typecheck, build, and fixture behavior.
