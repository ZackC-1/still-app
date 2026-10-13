---
title: Restore measured social-site tabs after a live Off change
date: 2026-10-12
type: fix
artifact_contract: ce-unified-plan/v1
product_contract_source: owner-remediation-brief
execution: code
---

## Goal Capsule

Objective: Facebook Page tabs stay readable when Still is switched off without reloading.
Means: let the site measure restored content after committed blocking changes (KTD1).
The owner authorizes implementation, verification, PR publication and protected merge; production, store packages and recorder answers remain outside this work.

## Product Contract

Facebook measures its Page tabs while the Reels tab is hidden. A live Off restores that tab but leaves Followers and More overlapping until reload (ISS-0040).

### Requirements

- R1. A committed service, free-row or global Off restores the Facebook Page tab and lets the site measure it again without reloading.
- R2. The same restoration works for Instagram profile tabs through the shared content runtime.
- R3. Initial hydration, unchanged settings, On changes and stopped content scripts must not generate unnecessary layout notifications.
- R4. Redirects and free blocking remain unchanged; no account, purchase, permissions or analytics changes.

The origin is the owner's local Lane B brief and ISS-0040. PR419 must be merged before this work; it merged at c917afe1 without the layout patch. Test set 7 was already built from 4b94f2c8 and will not contain this fix.

## Planning Contract

- KTD1. Reuse the existing content reapply path and notify the page after DOM restoration using one queued resize event. This follows the site's own measurement contract and avoids new CSS or a reload requirement.
- KTD2. Adapt Lane A's handoff tests and patch to fresh main, proving the regression before the production change.
- KTD3. Keep the remeasure in shared format-2 code so Chromium, Firefox and Safari use the same behavior. Browser fixtures prove the boundary; real signed-in Facebook/Safari layouts remain owner retests.

Directional sequence: committed settings -> shared DOM/marker reconciliation -> queued page layout notification.
Existing pattern: docs/solutions/ui-bugs/hiding-a-measured-tab-with-display-none-flickers.md.
No layout polling, synthetic user input or signed-rule changes are planned.

## Implementation Units

### U1. Restore measured tab layout

Requirements: R1 through R4.
Files: packages/core/src/content/index.ts; packages/core/src/content/__tests__/format2-navigation.test.ts; tests/playwright/fixtures-format2.spec.ts; tests/firefox/firefox.spec.ts.
Approach: preserve the effective-feature snapshot across reapply passes; notify only when a feature is removed and the document stays on the page. Run the notification after restoration and cancel its effect when stopped.
Execution note: add the regression tests first and record the expected failure before changing production.

Test scenarios:

1. Facebook service Off, free Reels row Off and global Off each restore content and notify once; initial hydration and On do not.
2. Instagram service Off restores its profile tab with the same notification behavior.
3. Reapplying unchanged settings does not repeat notifications; stopping before the queued notification prevents it.
4. A redirecting page does not receive a layout notification.
5. Shipped Chromium and real Firefox content scripts restore the Page tab and dispatch a page-visible notification after its contents are visible.

## Verification Contract

Run the focused navigation tests, then pnpm lint, pnpm typecheck, pnpm test and pnpm build.
Run pnpm exec playwright test --project=fixtures and the real Firefox lane; retain configured-lane coverage through required CI.
Record actual failures and passes. Live Facebook/Instagram layouts in Chrome, Firefox and Safari remain retests, not automated fixture evidence.

## Definition of Done

Regression proof is recorded, required local and CI checks pass, review findings are resolved and the scoped PR is merged without forcing.
ISS-0040 is FIXED_AWAITING_RETEST with its PR and FX-20 follow-up; no owner step is marked Pass.
Claims identify that this fix requires a package newer than delivered test set 7.
