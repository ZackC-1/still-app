---
title: The shared sign-in sheet carries why it opened, and "6‑digit" uses a non-breaking hyphen
category: ui-bugs
track: bug
problem_type: ui_bug
module: packages/core/src/ui
applies_when: A new entry point opens the shared sign-in sheet, or copy names the 6‑digit code
date: 2026-10-22
status: active
tags: [sign-in, still-pro, copy, text-wrapping, chrome, firefox]
---

# The sign-in sheet carries why it opened

## Symptom

Signed out in Chrome Settings, Get Still Pro opened the generic settings-sync sheet: "Sign in for
settings sync" and "Sign-in is optional. Blocking works without an account." (ISS-0123). The
browsers have no way to buy without an account, so the optional line was false there. Separately,
the consent line wrapped as "6-" / "digit" at common popup widths (ISS-0124).

## Cause

`SignInSheet.svelte` only knew a host-supplied title, prompt and note. The Apple host passed its
purchase copy explicitly (`APPLE_PURCHASE_SIGN_IN_COPY`), but the browser Settings card called
`controller.openSignIn()` with nothing, so the sheet fell back to the sync words. The purpose of the
sheet was a fact of the click, and nothing carried it to the sheet.

An ordinary hyphen-minus is a line-break opportunity, so "6-digit" may split at the end of a line.

## Solution

- `UiController.openSignIn(purpose = "sync")` records `signInPurpose` on every open. Get Still Pro
  (`InformationalProSettings.svelte`), `startUpgrade` and `reSignInFromCheckout` pass `"purchase"`.
  Every other entry (sync card, popup Sign in, invitation, first-run, Restore) stays `"sync"`.
- The purpose is persisted with the pending code entry (`PendingOtp.purpose`, stored by the
  extension background as `purpose: "purchase"`), so a Settings page reloaded at the code step, or
  the popup opened meanwhile, restores the purchase heading. It is deliberately not the
  `purchaseIntent` flag: the V3 Settings card never sets that, because it reopens the legacy
  paywall after sign-in. The background's own `requestCode` write keeps a purpose already stored
  for the same address; the page's write states it outright.
- The sheet uses `STRINGS.purchaseAuth` (owner ruling P2-19) for a purchase, including the email
  consent step's purchase variants, and never the "Sign-in is optional" prompt. Host props still
  override, so the Apple sheet keeps its "Buy without an account"; its copy now spreads
  `STRINGS.purchaseAuth`, so both platforms share one wording.
- Copy uses `SIX_DIGIT` (`"6‑digit"`, a non-breaking hyphen). Every bundled Inter (the web font,
  the design-system font and the Apple app's font) maps U+2011 to its `hyphennobreak` glyph, so no
  nowrap span is needed.

## Verification

- `packages/core/src/ui/__tests__/signin-purpose.test.ts`: purchase and sync sheets on Chrome
  (disclosure), Firefox (opt-in) and consent-free hosts; a closed purchase sheet does not colour a
  later sync sheet; restored code entry keeps its purpose.
- `extension-session.test.ts`: the purpose rides the pending-OTP record through a resend and the
  intent flag, and is dropped for sync or another address. `paid-tier-purchase-flows.test.ts` pins
  `startUpgrade` and `reSignInFromCheckout` to `"purchase"`.
- `browser-pro-host.test.ts`: the real options page, signed out, Get Still Pro shows the purchase
  consent and then "Sign in to get Still Pro" without the optional line (it failed before the
  fix); reloaded at the code step, the sheet still reads "Sign in to get Still Pro".
- `copy-audit-rules.test.ts` fails on a plain "6-digit" in any user-visible source (core UI, both
  extensions, the Apple web view and the owner page) and pins the Apple purchase copy.
- `tests/playwright/sign-in-six-digit-nowrap.spec.ts` (configured lane) sweeps the Settings page
  from 240 to 420 px: "6‑digit" is always on one line and moves to a new line whole. With the
  hyphen swapped back to a plain one in the page, the same measurement split it at 332 to 400 px.

## Prevention

Pass a purpose whenever a new control opens sign-in for something other than sync. Name the 6‑digit
code through `SIX_DIGIT` or a string built from it; the copy-audit test rejects a plain hyphen.
