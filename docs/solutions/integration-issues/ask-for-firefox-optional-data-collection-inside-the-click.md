---
title: Ask for Firefox's optional data-collection permissions inside the click, and check the grant before every send
category: integration-issues
track: knowledge
problem_type: integration_error
module: packages/ext-chromium
applies_when: A Firefox build sends a data type declared in `data_collection_permissions.optional`, or a test tries to drive Firefox's permission prompt
date: 2026-10-22
status: active
tags: [firefox, permissions, data-collection, consent, bidi, manifest]
---

## Context

Firefox lists the data an add-on sends in `browser_specific_settings.gecko.data_collection_permissions`.
Required types must be accepted to install, so a required type gates installing the free blocker.
Still declares only `authenticationInfo` (the sign-in session) as required. The sign-in email address
(`personallyIdentifyingInfo`), the Still Pro purchase status (`financialAndPaymentInfo`) and usage
data (`technicalAndInteraction`) are optional (owner decision, 22 Oct 2026). Optional types other than
`technicalAndInteraction` are not shown at install and are not granted until the person allows them.

## Rules that decide the design

- `permissions.request({ data_collection: [...] })` is honoured only inside the handler of a user
  action, and "if a user input handler waits on a promise, then its status as a user input handler is
  lost" (MDN, User actions). Firefox rejects anything else with "permissions.request may only be
  called from a user input handler", even when the type is already granted.
- Grants are listed in `permissions.getAll().data_collection` (Extension Workshop, built-in data
  consent). It also lists required types (`authenticationInfo`), and the installed manifest gains a
  normalized `has_previous_consent: false`.
- The person can withdraw an optional type in about:addons at any time.

## What works

- **Ask first, in the click.** `lib/data-permission.ts` `ask(kind)` calls `request` synchronously and
  reads `getAll` beside it, resolving `request || granted`. Inside a click it prompts (or answers
  silently when already granted); outside one the refusal is harmless and the grant read decides.
  Every click handler (the controller's sign-in, resend, verify and checkout; the Still Pro card's
  Get Still Pro, Try again and Restore; the free-period Restore) calls it before any `await`, after
  only synchronous guards. A flow that awaits before its send takes the ask from the tap (browser-pro
  `retry` passes its ask into `buy`).
- **Check before every send.** The page closures (`withDataPermission` in `purchase-wiring.ts`) and
  the flows' automatic re-checks read `granted` and send nothing without it. The background's Supabase
  fetch (`lib/firefox-data-guard.ts`) refuses the same requests once more as a network failure, which
  every caller already handles calmly.
- **Keep the hosts that lack the API clean.** Chrome and Safari get no `DataPermission`
  (`import.meta.env.FIREFOX` folds it away). Firefox-only modules avoid top-level calls
  (`Object.freeze`, `new Set`, computed lists): a module-level call survives tree-shaking and put
  Firefox's type names into the Chrome bundle (`tests/playwright/firefox-data-permission-build.spec.ts`
  scans for that).
- **Keep the no-permission path synchronous.** The controller awaits the ask only when there is one;
  an unconditional `await` delayed Chrome's code request by a tick and broke the in-flight guards.

## Testing limits

The real-Firefox lane (`tests/firefox`) cannot raise the prompt. BiDi has no input on extension pages,
and `script.evaluate` with `userActivation: true` does not count as a user input handler (checked on
Firefox 158 with `extensions.webextOptionalPermissionPrompts` false). The lane pins what it can see:
nothing optional granted at install, the refusal outside a click, and blocking with no grant
(`tests/firefox/data-permission.spec.ts`). The click handlers are covered by unit tests with a mocked
permissions API.

## Related

- `docs/release/store-listing-copy.md` (Firefox manifest declarations)
- [Open Firefox's Settings page in a tab](../ui-bugs/open-firefox-settings-in-a-tab-not-the-embedded-add-ons-panel.md)
- [Add paid-only code without changing shipped bundles](../conventions/add-paid-only-code-without-changing-shipped-bundles.md)
