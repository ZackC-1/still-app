---
title: Confirm Apple purchases on the hosted Edge Runtime (ISS-0070)
status: in_progress
date: 2026-10-16
---

# Confirm Apple purchases on the hosted Edge Runtime (ISS-0070)

## Problem

Apple sandbox purchases on the iPhone and Mac QA apps (2.1.1.370) succeeded at Apple, but Still
never confirmed them. The hosted `qa-sandbox-verify-apple-access` route returned
`{"status":"unavailable"}` and wrote no access right. Verify now and Restore purchase resend the same
evidence and got the same answer.

## Root cause (verified)

The Supabase Edge Runtime 1.77 (Deno 2.1.4) WebCrypto throws `Not implemented` for ECDSA whose hash
does not match the curve. Apple Root CA - G3 (P-384) signs its current OCSP responder certificate
with SHA-256, so the intermediate's revocation check always failed when hosted. Local Deno 2.8 and
the synthetic P-256 test chains never hit it. Evidence: hosted edge logs, a real sandbox transaction
read locally with a throwaway probe app, and the same code run in the edge-runtime 1.77 image. See
`docs/solutions/integration-issues/edge-runtime-webcrypto-rejects-mixed-ecdsa-curve-and-hash.md`.

## Change

- `apple-edge-verifier.ts`: a PKI.js engine that verifies EC certificate and OCSP signatures as a
  WebCrypto digest plus `@noble/curves` (DER, no low-S rule), independent of the runtime's
  curve/hash pairs. RSA keys and the JWS (`jose`, ES256) are unchanged.
- Pin `@noble/curves@2.4.0` in the shared and per-function import maps and in the lock.
- Regression test: a P-384 root with a SHA-256-signed delegated responder, under a WebCrypto that
  rejects mixed pairs as Edge Runtime 1.77 does. It failed before the fix; negative controls stay
  refused.

## Hosted step

Redeploy the QA functions with the protected `qa-sandbox-functions` operation (baseline-only, then
apply after owner approval). No client rebuild is needed: the app's Verify now and Restore purchase
resend the evidence to the same route. The production `verify-apple-access` shares the verifier and
gets the fix only through a separate, owner-approved production deploy. Paid tiers are off in
shipped builds.

## Verification

- `deno lint`, `deno check */index.ts`, and the Apple boundary, codec and handler suites (583 pass).
  The backend node suites pass (383 tests), including the frozen access runtime closure.
- Edge-runtime 1.77 image with the fix: the real sandbox transaction passes
  `verifyAndDecodeTransaction` and `authenticate()` 3 of 3, with live Apple OCSP.
- Not verified before the hosted deploy: the App Store Server API refresh step with the QA key.
  That needs the deployed route.

## Owner retest

IOS-45..48 + DB-13 (iPhone), MAC-46..48 + DB-14 (Mac). Use Verify now or Restore purchase on the
already-paid testers, or a never-purchased tester.
