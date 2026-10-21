---
title: Test purchase analytics from the real UI producer through the consent boundary
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core/src/analytics
applies_when: Analytics validators accept purchase events but real purchase UI never emits them
date: 2026-10-21
status: active
tags:
  - analytics
  - purchases
  - consent
  - testing
---

## Symptom and cause

An approved event schema can contain paywall and purchase events while the UI reports none of
them. Validation tests prove an event could be admitted, not that a user action produces it.
Still's V3 browser and Apple purchase hosts bypassed the legacy controller purchase flow and
had no analytics dependency. Ordinary usage continued to report successfully.

## Solution

Pass the existing consent-aware `UiAnalytics.track` port into the actual V3 hosts:
`ext-chromium/lib/browser-pro.ts` and `core/src/ui/v3/apple-pro-host.ts`. The entry points supply
the same analytics instance used by other UI actions. Catch measurement failures independently
of purchase state. Keep asynchronous outcome reporting behind the existing account/epoch fences.

An inline browser card has no reliable navigation trigger. Its view uses the fixed
`settings_card` value, once per page, only when a sellable card intersects a visible viewport.
Do not label loading Settings as viewing an offer or invent a particular locked-switch trigger.
The Apple analytics adapter resolves the store from its native platform context.

Resuming an existing checkout tab is not another purchase start. Restore is measured separately.
An ownership refresh can represent old access, another device, a restore or an isolated Apple
review right; never turn it into a new-sale event. A tab return alone has an unknown outcome.
Canonical sale/refund reporting needs a separate authoritative, deduplicated consent-aware path.

## Verification and prevention

- Exercise the real options UI and assert the background analytics message after Buy.
- Test viewport/visibility and duplicate impression behavior, account replacement, existing-tab
  recovery, restore and a throwing analytics port.
- Run the real V3 analytics factories with the build flag but without injected permission/policy
  seams; assert delivery to a mocked sink and silence after withdrawal.
- Keep server sale events inadmissible from client pages. Test the closed event schema against
  unexpected URL properties.

The corresponding checks live in `browser-pro.test.ts`, `browser-pro-host.test.ts`,
`default-on-analytics.test.ts`, `apple-pro-host.test.ts`, `apple-default-on.test.ts` and
`analytics/__tests__/privacy.test.ts`. These prove source wiring; deployed delivery is a separate
release check.

Related: [production analytics gate testing](test-seams-hid-an-analytics-gate-production-never-satisfied.md),
[ADR 0004](../../adr/0004-first-party-usage-analytics.md).
