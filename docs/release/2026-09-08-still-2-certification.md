# Still 2.0 candidate certification

Status: **No-Go — implementation and verification in progress**. Issue #153 stays open.

Preparation base: `b98f801e7036bac21d0687b18eed0aee88723ee6`. Final candidate and source-to-artifact
manifest: pending reviewed integration of #149–#152. No prior-release artifact or device result is
counted as evidence for this candidate.

## Candidate requirements

Shipping marketing versions are 2.0.0 for Chromium, Firefox, Safari resources and Apple apps.
The prepared Apple build is 7 (incremented from source build 6); verify live store history before
submission. Application/add-on IDs and the four-service host boundary are unchanged. Both paid
tier switches remain false. Blocking is free without an account; account sync is optional.

| Prerequisite | Current evidence |
|---|---|
| #149 account lifecycle isolation | Implementation/review pending |
| #150 export read errors | Implementation/review pending |
| #151 configured popup geometry/CI | Implementation/review pending |
| #152 retention, cleanup and privacy draft | Implementation, local migration verification and deployment approval pending |

## Artifact and host matrix

| Artifact / surface | Build / hash | Required host result |
|---|---|---|
| Chromium ZIP | Pending frozen candidate | Actual installed toolbar/options and four websites: unverified |
| Firefox ZIP + full sources | Pending frozen candidate and clean rebuild | Actual Firefox toolbar/options/site behavior: unverified; AMO signing separate |
| macOS app + Safari | Signed Release archive/export pending | Native webview, Safari, App Group and restart journeys: unverified |
| iOS app + Safari | Signed Release archive/export pending | Physical iPhone native/Safari journeys: unverified |
| iPadOS app + Safari | Same candidate identity, installation pending | Physical iPad coverage: unverified |

Each result must identify device/browser/OS, exact artifact hash, steps, expected/actual behavior
and evidence. Required journeys include fresh install, no account/purchase, offline blocking on
all four services, ordinary content, master/service controls, pause, persistence/restart/sign-out,
light/dark, narrow widths, keyboard/accessibility and larger text. Approved synthetic-account
journeys cover new/existing adoption, two devices/reconnect, A → B → A, delayed responses,
offline edits, deletion/re-creation and the retained local safety marker.

## Verification and release decision

Final candidate gates remain pending: lint, typecheck, unit tests, build, fresh configured and
unconfigured Playwright fixtures, frozen Deno tests/checks, disposable local database migrations,
real StillKit tests, applicable Xcode checks, independent standards/spec review, regression
mutation verification and final security/artifact inspection.

The final manifest must record source and reviewed fix commits; tool versions; build commands;
public configuration names and capabilities; artifact SHA-256s; embedded versions, IDs and
permissions; signing identity class and nested signature results; backend revision/migrations;
and evidence paths. Never include private keys, credentials, customer data or working notes.

| Outstanding action | Owner | Completion evidence |
|---|---|---|
| Complete reviewed fixes and candidate gates | Implementation coordinator | Exact commits, PRs, test results and artifact manifest |
| Supply any missing distribution signing/provisioning | Founder | Approved signing action and validated exports from candidate |
| Perform unavailable physical/native host checks | Founder + verifier | Exact candidate/device journey matrix |
| Verify provider logs, quotas and retention limitations | Founder + backend verifier | Read-only provider evidence and policy decision for any mismatch |
| Approve backend deployment and legacy-counter purge | Founder | Reviewed commands, recovery plan, then deployed revision/schema and verification |
| Approve privacy/store drafts and release submission | Founder | Exact reviewed text, candidate hashes and per-store action |

Prepare commands, effects, verification and recovery before requesting external-action approval.
Green automated checks alone do not authorize a Go decision. Missing device, signing, provider or
deployment evidence remains an open gate.
