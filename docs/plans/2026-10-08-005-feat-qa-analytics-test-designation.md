---
title: "Mark QA analytics and accounts as test, and keep them out of real metrics"
status: draft (plan only; no source change until the coordinator and owner sign off)
date: 2026-10-08
owner_lane: Claude Code L4 (see work-state v31-agent-ownership-20261008)
gates: engineering-gates 8 and 18; configuration-checklist E10-E12; ISS-0020/0021; DB25/DB26
---

# QA analytics test designation

## Problem

The owner requires that test accounts and test purchases are marked as test in the database and in
PostHog, and are easy to exclude from real metrics. Current source (main `2bf60567`):

- The event envelope already allows `build_channel` with values `release | dev | test`
  (`packages/core/src/analytics/events.ts` `ANALYTICS_BUILD_CHANNELS`), validated in
  `packages/core/src/analytics/client.ts`. **No host sets it**, so no event carries it today.
- The `local`, `test` and `paid-sandbox` QA profiles (`scripts/qa/v3-profile.mjs`) strip every
  `VITE_POSTHOG_*` input, so **QA builds currently send no analytics at all**. Analytics delivery,
  consent and erasure therefore cannot be tested on a QA package yet.
- Database side: V3 access rows separate `sandbox` from `production`, and the U6 QA registry admits
  the eight dedicated QA accounts server-side. Settings-sync rows and legacy entitlement rows carry no
  test marker.

## Decision needed from the owner (one question)

Where should QA analytics go?

1. **Separate PostHog project for QA (recommended).** QA builds embed only the QA project's public
   key. Real dashboards never see test traffic, so nothing needs excluding. Every QA event also
   carries `build_channel: "test"` as a second marker. Cost: the owner creates one free PostHog
   project and gives engineering its public project key (a `phc_` client key, not a secret). Erasure
   tests need the QA project's personal API key as a hosted QA secret, because `delete-user` and
   `analytics-erasure` currently target the production project only.
2. **Same PostHog project, marked.** Every QA event carries `build_channel: "test"` and QA accounts get
   a server-set `is_test_account` person property; every real dashboard and insight must filter both
   out. Cheaper to set up and reuses the existing erasure path, but a single forgotten filter pollutes
   real metrics, and the person property is new collected data that needs an ADR 0004 privacy review.

## Plan (applies to either choice unless noted)

U1. **QA builds declare `build_channel: "test"`.** Add a build-time channel input set only by the QA
    profiles and listed in `scripts/release/package.mjs` `DELIBERATELY_UNPACKAGED`; hosts pass it in
    `envelope`. Store packages keep sending no channel (or explicitly `release`, if the owner later
    wants release builds marked; that is a separate decision). Tests: QA profile environment, envelope
    propagation on Chrome/Firefox/Safari/app-webview hosts, refusal of an unknown channel.
U2. **QA builds may embed only a QA analytics key.** For choice 1, the paid-sandbox profile accepts
    `STILL_QA_POSTHOG_KEY`/`STILL_QA_POSTHOG_HOST` and refuses the production key fingerprint, so a QA
    package can never report into real metrics. For choice 2, it accepts the production key only with
    U1 in place.
U3. **Erasure parity (choice 1).** QA-route erasure must delete the person from the QA project. This is
    backend work in the coordinator's lane (new QA secret names, no change to production functions).
U4. **Database marking.** Prefer deriving "test" from existing authority (U6 QA registry membership and
    `environment = 'sandbox'` access rows) in the read-only reporting queries over adding columns.
    Provide two saved queries for the owner's DB25/DB26 rows: test accounts and their rows, and
    production metrics with test accounts excluded. Schema changes, if any, belong to the coordinator.
U5. **Evidence.** One QA package journey per surface with analytics on and off, confirming in the
    chosen project that events arrive with `build_channel: "test"`, nothing arrives when off, and
    deletion removes the person. Synthetic tests do not replace this.

## Privacy and product constraints

- No new events; the closed schema is unchanged. `build_channel` is an existing envelope field.
- Choice 2's person property is new data and needs the ADR 0004 privacy review and store-declaration
  check before it ships in any build; choice 1 needs neither.
- Replay, autocapture and AI customer analysis stay off. Consent stays the single combined D531
  permission. Free blocking and sync never depend on analytics.
