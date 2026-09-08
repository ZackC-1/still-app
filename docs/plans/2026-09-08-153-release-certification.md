---
title: Still 2.0 release certification
date: 2026-09-08
status: in-progress
issue: 153
---

Prepare release inputs from `b98f801e7036bac21d0687b18eed0aee88723ee6`, then certify a
frozen candidate containing independently reviewed fixes for #149–#152.

## Scope

- Set shipping extension and Apple marketing versions to 2.0.0; increment the Apple build.
- Correct bundled release descriptions and current build/release instructions for free blocking
  with optional account sync. Preserve identifiers, permissions and dormant purchase code.
- Build Chrome/Firefox ZIPs and reproducible complete Firefox sources from the frozen candidate.
- Attempt signed Apple Release archives using existing signing resources; external provisioning
  changes, deployment, publication and submissions require separate approval.
- Record source/artifact hashes, configuration capabilities, backend prerequisites, verification
  and unverified host/device/provider rows. Keep private operational evidence outside Git.

## Verification

The agreed boundaries are generated manifests, packaged resources and installed host journeys.
Verify versions/descriptions/permissions in fresh bundles and archives. Run final lint, typecheck,
unit tests, build, configured/unconfigured Playwright fixtures, frozen Deno/local database checks,
real StillKit tests and applicable Xcode builds. Independently review standards/spec compliance,
then verify regression sensitivity and security at the frozen candidate.

## Progress

- Confirmed the integration tip and predecessor merges; no existing implementation PRs.
- Confirmed old shipping versions and paid manifest description in the current source.
- Final candidate, artifacts, reviews and host/device evidence remain pending.

- Preparation check: Chromium typecheck and 34 extension tests passed; `pnpm build` passed.
  Fresh Chrome/Firefox/Safari manifests report 2.0.0, unchanged four-service host permissions
  and no paid-blocking description. All eight Apple configurations report 2.0.0 (7).
  This is packaging verification before integration, not final candidate certification.
