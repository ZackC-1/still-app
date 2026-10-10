---
title: Test the production analytics wiring without the seam that satisfies the gate
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core/src/analytics
applies_when: A client gate needs inputs (permission, policy, evidence) that tests inject; or an extension host observes events before its first account answer
date: 2026-10-10
status: active
tags:
  - analytics
  - consent
  - shipped-bundles
  - testing
---

## Symptom

V3 QA packages (test set 5, Chrome) sent zero requests to PostHog in about two hours of real use.
The "Share usage data" row on the first-run and settings pages showed off, and turning it on did
nothing. The Apple app showed no switch at all. Every analytics unit test passed.

## Root cause

The client admits work only when `readAuthority` (client.ts) finds a ready privacy policy, a true
`consent()`, and a granted permission record whose version matches the policy. In V3, no production
host supplied a policy or a permission, and nothing ever granted one:

- Chrome/Firefox: `createBackgroundAnalytics` (ext-chromium `lib/analytics.ts`) passed neither, and
  `createStoredConsent(...).get()` is true only for a granted record that nothing created.
- Safari extension: the background passed no `permission` or `privacyPolicy`.
- Apple app: `createAppAnalytics` got neither, so `ready()` returned null: no client, no switch.
- `privacyPolicyReady` also required verified evidence for six erasure/retention capabilities, which
  no host could truthfully supply.

The host tests injected a synthetic permission and a fully "verified" policy through `vi.mock` of
`createExtensionAnalyticsHost` (and `TEST_PRIVACY` for the Apple app), so they exercised a wiring no
package ran. One test file even said so ("Production wrappers still omit this seam").

A second fault appeared once sends could happen: the start's first account answer
(`client.confirm`) cancels every observation made before it, and Chrome delivers `onInstalled` while
the start's account read is still pending. `installed` and `setup_completed` were dropped unless the
read happened to settle first. The tests always called `onStart(null)` synchronously before
`onInstalled`, so they never saw it.

## Fix

The owner reaffirmed ADR 0004 for V3 (on by default, per-device off switch; Firefox follows the
optional `technicalAndInteraction` permission). `analytics/default-on.ts` is the authority: a
permission record granted on the first read with no recorded choice, stopped by the switch, and for
Firefox mirrored from the browser permission. Hosts pass it with `DEFAULT_ON_USAGE_POLICY` from
their V3 branches only:

- background.ts chooses `createDefaultOnBackgroundAnalytics` (which also observes `onInstalled` only
  after the start's account read settles);
- the Safari background spreads `defaultOnSafariAnalytics` (the app's record via a read-only native
  `analyticsPermission` lane, StillKit `extensionReply`);
- the app web view chooses `createDefaultOnAppAnalytics`, which keeps the switch visible while off
  and re-tells a new client who is signed in after the switch turns sharing back on.

`privacyPolicyReady` accepts the `adr-0004` basis only when `USAGE_ON_BY_DEFAULT_BUILD`
(build-basis.ts, the one place core reads build flags) is true, so the branch folds out of 2.x
bundles.

## Verification

- `default-on-analytics.test.ts` (ext-chromium, ext-safari) and `apple-default-on.test.ts` run the
  production factories with no seam. Each starts with a root-cause case: the 2.x wiring reports
  nothing even with sharing nominally on.
- The install case resolves the start's account read immediately after `onInstalled`; with the
  unwrapped host it fails at every microtask gap tried (0 to 30).
- Bundle identity: store-shaped 2.x, configured and unconfigured lanes byte-identical; V3 profiles
  change only the three backgrounds and the app web view's main chunk.

## Prevention

- For every host, keep at least one test that builds the production factory exactly as the entry
  point does, with no `vi.mock` of the host or its gate inputs, and asserts a request is made.
- When a seam injects evidence a gate needs, add a test proving production supplies it too.
- Any host that observes events at startup must assume the first account answer can land at any
  point after; observe after it, or test that order explicitly.
- Background-entry tests that stub `../analytics.js` must also stub `../default-on-analytics.js`
  (V3 builds choose it).

Related: [ADR 0004](../../adr/0004-first-party-usage-analytics.md),
[shipped-bundle convention](../conventions/add-paid-only-code-without-changing-shipped-bundles.md).
