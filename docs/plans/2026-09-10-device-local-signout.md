# Keep sign-out local to the current device

Status: implemented and independently reviewed; updated Mac installed and Chrome test package refreshed. Owner reload, fresh Mac sign-in and live sync retest remain pending.
Base: 874e6db, retaining the installed 62ddc85 runtime plus website-only documentation updates.

## Problem and intent
After Chrome sign-out and sign-in, a Mac Facebook-off edit did not reach Chrome. The Mac displayed saved-locally/reconnect wording with an old sync timestamp. The shared auth adapter uses default global logout. Supabase documents that this revokes other devices' refresh tokens, with delayed failure when access tokens expire. The exact hosted incident has not been inspected; the cross-device defect is reproduced with synthetic sessions and the real SDK.

## Change
Use local scope for both existing logout attempts, preserving extension storage teardown and account-deletion behavior. Keep the change in the shared adapter used by Apple and browser builds. Update the existing auth tests and overlapping solution document. No backend, schema, account-policy, paid-tier, or production data change.

## Verification
Real-SDK two-device regression: before fix, 1 fails and explicit-global control passes; after fix, both pass. Focused auth, session and teardown suite: 98 passed. Full checks: 788 unit tests passed (39 intentional paid-tier skips), lint/typecheck passed, 53 browser fixtures passed. Configured Chrome, Firefox, Safari and WebUI builds and signed Mac Release build passed. Independent spec and standards/security reviews passed. Restoring the original default-scope call failed the two-device regression; source bytes were restored afterward. Initial full unit run started before generated WXT types existed; after type generation, the unchanged suite passed.

## Recovery and live validation
Install updated Chrome and Mac builds in place, preserving settings and prior packages. Existing revoked Mac session requires a fresh user sign-in. Retest Mac-to-Chrome sync after backgrounding, then Chrome-to-Mac restoration. An old iPhone/browser build can still perform global logout until updated; physical-device and final package gates remain open. Do not treat successful synthetic tests as live recovery evidence.
