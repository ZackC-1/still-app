---
title: Day-only analytics timestamps must not fall before the install they follow
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core
applies_when: A quiet (day-only) analytics event is a later step of a funnel whose first step has a precise timestamp
date: 2026-09-30
status: active
tags: [analytics, posthog, funnel, safari, timestamps, privacy]
---

# Day-only analytics timestamps must not fall before the install they follow

## Symptom

The activation funnel `installed → setup_completed` showed no conversion for the Apple stores,
although the Safari extension did send `setup_completed` for those people. For each person, the
extension's `setup_completed` was some hours earlier than the app's `installed`. Chrome converted
normally.

## Cause

Two hosts record the two steps with different timestamp precision:

- The Apple app web view sends `installed` at the precise launch moment.
- The Safari extension records its setup milestones quietly (ADR 0004: a background start can mean a
  supported site was opened), so they carry only local midnight of their day.

A setup finished on the install day is therefore stamped before the install. PostHog funnels need
each step at or after the step before it, so the conversion is lost.

Chrome and Firefox send both events with the same `at`. PostHog counts equal timestamps in step
order, so those funnels convert. Equal timestamps are not a defect.

## Fix

- StillKit records the moment the app counts a new install (`still.analytics.installed-at`, ms) in
  the App Group. It reports that moment to the web view (`analyticsContext.installedAt`) and to the
  Safari extension (`extensionReply` `installedAt`). Updates record nothing.
- The web view reports `installed` at that native moment.
- `TrackOptions.notBefore` is a floor for a quiet event: the event is stamped at the floor when the
  floor is inside the event's own day and not later than the event. Otherwise the event keeps
  midnight. The extension host passes the install moment as the floor for its quiet activity.

## Why this keeps the privacy rule

The floor is the install moment, which `installed` already reports precisely. A floored stamp
tells only that the event happened on the install day, after the install. The day was already
known. The stamp still says nothing about when a supported site was visited.

## Where it does not apply

- An app from before this change has no install moment. Its extension keeps midnight stamps.
- Events already ingested keep their old timestamps. Read Apple setup conversion from events
  recorded by a build with this change, or compare days instead of moments for older data.

## Verification

- `packages/ext-safari/lib/__tests__/analytics.test.ts` ("Safari setup is never stamped before the
  app's install") checks the floor, the later-day and absent cases, and that the app's `installed`
  and the extension's `setup_completed` are in funnel order. The tests fail without the floor and
  pass in several time zones.
- `AnalyticsIdentityTests` checks that an install records its moment once and an update records
  none. These need Xcode.

## Prevention

When a funnel step is recorded quietly, compare its stamp with the precise stamp of the step before
it on the same day. Use a floor from an event already reported precisely. Never use a precise
moment from the quiet event itself.
