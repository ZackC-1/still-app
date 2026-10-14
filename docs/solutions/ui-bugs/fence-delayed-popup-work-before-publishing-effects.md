---
title: Fence delayed popup work before publishing its effects
category: ui-bugs
track: bug
problem_type: ui_bug
module: packages/ext-chromium
component: frontend
severity: medium
symptoms:
  - A reopened popup temporarily loses its available Still Pro card.
  - Late settings-page layout moves the offer away from its arrival position.
root_cause: async_timing
resolution_type: code_fix
date: 2026-10-14
status: active
tags: [popup, async, cache, navigation, focus]
---

# Fence delayed popup work before publishing its effects

## Problem

Delayed UI work can preserve the visible state while publishing an obsolete side effect. A popup
request fence must cover the remembered answer used by the next opening, and a navigation request
must stop moving the page once the person takes control.

## Symptoms

A newer readiness reply showed the Pro card correctly, but an older reply replaced its session
cache with `false`. Reopening then began with the stale answer. Separately, scrolling an offer into
view at its first mount did not keep its heading visible after later content changed the layout.

## What did not work

Guarding the assignment to the live Svelte state was insufficient: the helper had already saved
the response before returning to that guard. Retrying a readiness request made overlapping replies
more likely. A test that checked only the current popup could miss the poisoned reopen cache.

For offer arrival, centering a long card could obscure its heading. Disconnecting the observer at
first mount also treated mounting as proof that layout had finished.

## Solution

[PopupApp.svelte](../../../packages/ext-chromium/entrypoints/popup/PopupApp.svelte) bounds startup
retries and refreshes after committed-binding observations. Each request captures a revision;
only a reply belonging to the live, current request updates the view and remembered answer.
[pro-navigation.ts](../../../packages/ext-chromium/lib/pro-navigation.ts) keeps the readiness query
read-only and exposes the separate cache publication. A current `false` still replaces a previous
`true`; preserving stale positive answers would defeat the availability check. This cache controls
presentation only. Checkout retains its own fresh checks.

The options navigation binding aligns the existing offer at its start and focuses that card once
per navigation request. Mutation and resize observations can correct late layout during the
bounded request lifetime. Pointer, keyboard, wheel or touch interaction cancels those corrections;
cleanup disconnects observers and listeners. Do not extend arrival correction into continuous
scroll enforcement.

## Why this works

The boundary is the side effect, not the callback's final return. Updating a cache before accepting
a response leaks obsolete work into another view. Continuing layout correction after user input
similarly lets an old navigation request override a newer intent.

## Prevention and evidence

The reversed-reply regression in
[pro-navigation-host.test.ts](../../../packages/ext-chromium/entrypoints/popup/__tests__/pro-navigation-host.test.ts)
failed before the cache repair. It resolves the newer reply first, then the older one, reopens the
actual popup host from the remembered answer, and confirms a subsequent current `false` withdraws
availability. Navigation tests cover late insertion, focus preservation and cancellation on user
interaction. [pro-offer-ready.test.ts](../../../packages/ext-chromium/lib/__tests__/pro-offer-ready.test.ts)
also proves querying alone does not write session storage.

Rendered Chromium, WebKit and Firefox checks kept the heading visible after a late 260px insertion.
Those engine checks do not establish real extension-toolbar geometry or Android back navigation.
Keep those acceptance checks separate from DOM and mocked-port tests.

For a different cache boundary, see
[preserve original access freshness](../logic-errors/preserve-original-access-freshness-across-shared-requests.md).
