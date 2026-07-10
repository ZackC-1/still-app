# Release Validation

Current validation record for commit
`5678e1b4ef683d0ba1857dff68583c9b40437b95` on July 10, 2026.

## Automated Checks

| Area | Result |
|---|---|
| GitHub CI: lint, typecheck, unit tests, builds | Pass |
| GitHub CI: Supabase Edge Functions | Pass |
| GitHub CI: Playwright fixtures | Pass |
| Chromium production build | Pass |
| Firefox production build | Pass |
| Safari extension tests | Pass: 4 files, 25 tests |
| Safari extension typecheck and production build | Pass |
| Signed macOS app and embedded extension build | Pass |
| iOS simulator build, install, launch, and visual smoke | Pass |
| Signed physical-iPhone build and installation | Pass |
| Local Supabase migrations and database tests | Pass: 32 tests |

The linked hosted Supabase project and the local database both include migrations `0001` through
`0009`. Migration `0009_profile_settings_server_clock.sql` is required by these clients and must be
present in every environment where this build is installed.

## Manual Cross-Surface Checks

All checks used the same signed-in entitled test account. Account identifiers are intentionally not
recorded in the repository.

| Scenario | Result |
|---|---|
| Baseline settings converge across active surfaces | Pass |
| Chrome global setting updates macOS and an open supported page | Pass |
| macOS service setting updates Chrome popup, options, and content | Pass |
| iOS setting updates macOS and Chromium surfaces | Pass |
| macOS setting updates an already-open Safari page | Pass |
| Firefox writes converge with Apple and Chromium surfaces | Pass |
| Later server-accepted conflicting write wins everywhere | Pass |
| Settings persist after popup, app, and device restart | Pass |
| Safari exposes exactly one registered Still extension | Pass |

Chrome, Firefox, macOS, macOS Safari, the iOS simulator, and a physical iPhone were included in the
release cycle. The physical iPhone accepted the signed build; interactive behavior was subsequently
validated manually.

## Release Boundary

The client and backend contract is validated. App Store, TestFlight, Chrome Web Store, and Firefox
AMO submission remain separate human-gated release actions. Delaying store review does not permit
delaying migration `0009` in an environment that receives this client build.
