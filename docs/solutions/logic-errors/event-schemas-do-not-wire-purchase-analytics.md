---
title: Test purchase analytics from the real UI producer through the consent boundary
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core/src/analytics
applies_when: Analytics validators accept purchase events but real purchase UI never emits them
date: 2026-10-21
status: active
last_updated: 2026-10-21
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

## Canonical web events require two permission boundaries

An active server-side analytics subject establishes identity and erasure state, not current device
permission. The off switch sends no request, so a payment webhook cannot infer permission from an
old subject. Bind optional attribution only in the winning, serialized checkout creation claim;
later retries and later opt-in cannot backfill it. A fresh consenting request from that same origin
can then claim canonical ledger events, with stable random event IDs and the original paid/refund
timestamps. Token-CAS completion protects replacement claims, and a finite entry-time deadline
bounds dispatch even when authentication or rate limiting stalls. Financial writes remain
independent: optional attribution errors and lock contention must not abort or delay fulfilment.

Checkout caches the optional attribution switch at startup. Protected switch operations must
refresh it as well as the reporter. Reusing the closed purchase deployment prerequisites avoids
refreshing a payment route with missing live configuration. On emergency disable, stop reporters
first and report an incomplete outcome if checkout cannot refresh; a matching secret alone cannot
prove warm instances stopped collecting. Repeat the same sealed bundle and verify readback.

`purchase_analytics_test.ts` proves SQL serialization, nonblocking refund contention, canonical
ordering, lease replacement and erasure. `production-checkout-runtime.test.ts` proves warmed
runtime behavior through off/on/off recomposition; `analytics-subjects.test.mjs` proves preflight,
partial disable and retry. Device/SDK tests retain the fresh consent and account dispatch fences.
The resulting events cover a consented subset and cannot reconcile total sales.

## Apple canonical results use a dedicated transport boundary

A native `purchased` result is not proof of a new sale: the existing purchase manager also uses
it for already-owned access. Optional new-sale provenance must originate only in the actual
SDK purchase branch, match a locally verified production transaction, and differ from a known
preflight transaction. Read that optional preflight before the fresh sales-policy boundary.
Any optional asynchronous preparation in the host must also remain inside its pre-charge
account/access checks; setting acquisition state before that await can let a departed scope
reach StoreKit.

The server binds a fresh prepared intent to canonical Apple verification and authors event UUID,
time and the fixed purchase properties. A dedicated immediate client transport preserves the
originating device's existing consent and exact identity scope, including its anonymous identity.
Generic `track` and persisted queues still reject both canonical purchase event names. Never send
an erasure key to the backend just to let it derive an anonymous PostHog identity.

Event age and attribution retention are different bounds. An old undelivered sale must not stop
a freshly verified refund from being reported while its original attribution is still eligible.
Apply the thirty-day age bound independently to each descriptor; keep stable UUIDs and original
timestamps across ordinary foreground retries. The ninety-day optional attribution bound means
late refunds are deliberately undercounted, independently of functional purchase rights.

`apple-canonical-receipt.test.ts` proves generic rejection, scope withdrawal, stable retry, local
restart, bounded retention and the old-sale/fresh-refund case. `AppleNewPurchaseProvenanceTests`
and the actual native bridge/host tests cover new-versus-owned provenance and pre-charge races.
The Apple verifier's generated-certificate tests distinguish explicit full refunds from partial,
family and ambiguous revocations. See [ADR 0004](../../adr/0004-first-party-usage-analytics.md) for
the approved server-authority/client-transport distinction.
