---
title: Admit QA packages 2.1.1.370 and 2.1.1.371 to the sandbox sales policy (ISS-0069)
status: in_progress
date: 2026-10-16
---

# Admit QA packages 2.1.1.370 and 2.1.1.371 to sandbox sales (ISS-0069)

## Problem

During the 16 Oct Still Pro purchase sitting (CH-49), Chrome QA build 2.1.1.370, signed in, showed
"Still Pro can't be bought here yet." with only Restore purchase. Signed out it offered Get Still Pro
and sign-in first, as designed.

The published sandbox sales policy (revision 9, read 16 Oct) lists the web surfaces only for
2.1.1.351, .357, .359 and .361, plus the Apple hosts at 2.1.0. The background's sales check uses the
extension's manifest version, so 2.1.1.370 is refused. Nothing is wrong with the package; the
delivery step that checks the allowlist was missing, and the .370 card had no revision line.

## Change

- Add `chrome_desktop`, `firefox_desktop` and `firefox_android` entries for **2.1.1.370** (installed
  now) and **2.1.1.371** (the Facebook-only follow-up, built from a88e4ad9) to
  `QA_SANDBOX_SALES_BUILDS` and to both pinned `qa-sandbox-sales-policy-{on,off}.sql` templates;
  re-pin both hashes. Earlier entries, channels, offer, product, cutoff and production are unchanged.
  One revision covers both packages.
- `scripts/qa/README.md`: a delivery checklist. Every paid-sandbox package card states the allowlist
  revision it was checked against and that its web version is listed.
- Merging advances the QA sequence (to 372), so the versions listed are the packages already built.

## Hosted step

After merge, run the protected `qa-sandbox-sales-policy` operation, mode `on`, expected revision 9,
first `plan-only` and then `apply`, so sandbox sales revision 10 is published. The apply waits for
the owner's environment approval; agents never approve it. Production is never named by the
operation.

## Verification

- `operations.test.mjs` pins the JS list and both SQL templates identically, including the new
  entries (48 tests pass), and the other backend deploy suites pass (279 tests, 0 failures).
- After apply: `POST {"namespace":"sales","environment":"sandbox"}` to
  `/functions/v1/qa-sandbox-product-policy` returns revision 10 with 2.1.1.370 and 2.1.1.371 listed
  for the three web surfaces and all earlier entries kept.
- Owner retest: CH-49, then S04-G01 (CH-50..62, DB-07..09) and S04-G02 (FX-43..49, DB-10..11).
