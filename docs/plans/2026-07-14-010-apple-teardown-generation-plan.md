# Apple teardown generation guard

Date: 2026-07-14
Status: implementation-ready
Source: `2026-07-14-003-engine-page-session-context.md`

## Goal

Prevent a pre-teardown Apple-session reconcile from mirroring a stale confirmed entitlement after a
successful voluntary sign-out or account deletion.

## Decision

Use a local generation guard in `createAppleSession`. Each voluntary teardown advances the
generation; late signed-in state for an older active generation is ignored, while the definitive
signed-out state still projects and clears the App-Group entitlement. Do not alter `SyncService` or
share teardown machinery across session orchestrators.

## Test scenarios

- Begin `enterSession`, hold its `onSignedIn` continuation, sign out, then resolve it; the last
  App-Group entitlement write remains `false` and the controller remains signed out.
- Existing sign-out and account-deletion teardown parity tests remain unchanged.

## Verification

- Focused Apple session tests demonstrate the race failing before the guard and passing after it.
- Full lint, typecheck, unit, build, and fixture checks run before merge.
