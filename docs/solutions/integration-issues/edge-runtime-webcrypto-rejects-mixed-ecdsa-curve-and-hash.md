---
title: Supabase Edge Runtime WebCrypto rejects ECDSA when the hash does not match the curve, so Apple OCSP failed only when hosted
category: integration-issues
track: bug
problem_type: integration_error
module: supabase/functions/_shared/apple-edge-verifier.ts
applies_when: A WebCrypto signature check passes in local Deno or tests but fails on the hosted Supabase Edge Runtime, or Apple verification returns "unavailable" for genuine purchases
date: 2026-10-16
status: active
tags: [apple, storekit, ocsp, webcrypto, ecdsa, supabase-edge-runtime, deno]
---

## Symptom

ISS-0070. On the iPhone and Mac QA apps (2.1.1.370), Apple's sandbox sheet confirmed the purchase.
Still then said "The purchase wasn't confirmed." and "Your purchase needs to be verified.", and
Verify now and Restore purchase changed nothing. The hosted `qa-sandbox-verify-apple-access` route
answered every call with HTTP 200 `{"status":"unavailable"}` in under a second, and no access right
was written. StoreKit and RevenueCat had both completed the purchase.

## Cause

Apple Root CA - G3 has a P-384 key. Its current OCSP responder certificate (issued 24 Aug 2026) is
signed with `ecdsa-with-SHA256`. Checking the intermediate's revocation status means verifying that
certificate: ECDSA with a P-384 key and SHA-256.

Supabase Edge Runtime 1.77 ("compatible with Deno v2.1.4") implements WebCrypto ECDSA only for the
matched pairs P-256/SHA-256, P-384/SHA-384 and P-521/SHA-512. Anything else throws
`NotSupportedError: Not implemented`. PKI.js treats the throw as an invalid path ("Validation of
signer's certificate chain failed: No valid certificate paths found"). The verifier fails closed
and the route returns `unavailable`.

Current Deno (2.8) accepts every pair, so the same code passed on a developer machine and in CI.
The synthetic test chains used P-256 with SHA-256 throughout and never exercised a mixed pair.

## How it was found

- Hosted edge logs showed each verification call answering 44 bytes (a compressed
  `{"status":"unavailable"}`) in about 0.6 s, with no Postgres errors from the QA writer role.
- A real sandbox transaction was read locally from StoreKit with a throwaway dev-signed probe app
  using the same bundle id. It never left the machine. It passed the production verifier in local
  Deno, including live Apple OCSP.
- The hosted route refused the real transaction as quickly as a deliberately broken one, so the
  failure was at or near the signature checks.
- The same code in the `public.ecr.aws/supabase/edge-runtime:v1.77.0` image refused it with the
  responder-chain error. A probe in that runtime showed `crypto.subtle.verify` throwing
  `Not implemented` for P-384 with SHA-256 and P-256 with SHA-384.

## Fix

`AppleCertificateEngine` (a PKI.js `CryptoEngine`) overrides `verifyWithPublicKey` for EC keys. It
takes the digest with WebCrypto (`digest` works for every hash) and checks the DER signature with
the audited `@noble/curves` (`prehash: false`, `lowS: false`, since X.509 signatures need not be
low-S). Unknown curves or hashes return `false`, and RSA keys keep PKI.js's own path. The JWS
itself still uses `jose` (ES256 is a matched pair). `@noble/curves@2.4.0` is pinned in every
per-function import map that loads the Apple verifier, and in the shared lock.

## Verification

- `apple-edge-verifier.test.ts` adds a P-384 root whose delegated responder certificate is signed
  with SHA-256. `crypto.subtle.verify` is replaced to behave as Edge Runtime 1.77 does. The case
  failed with the exact hosted error before the fix. After the fix it passes, and a tampered
  responder certificate, a tampered response and a responder issued by another P-384 root are
  still refused.
- The real sandbox transaction passed `verifyAndDecodeTransaction` and `authenticate()` three
  times in the edge-runtime 1.77 image with the fix, with live Apple OCSP.

## Prevention

- Test certificate code against the hosted runtime image, not only current Deno. Version drift in
  WebCrypto support hides there.
- Model real provider chains in tests, including mixed key/hash pairs. Apple can rotate responder
  certificates to a different signature hash at any time.
- A fail-closed verifier that answers one generic `unavailable` needs a reproducible way to see
  which step refused. Here that was the runtime image plus one real transaction.
- Related: [verify-apple-transaction-before-issuing-scoped-access](../security-issues/verify-apple-transaction-before-issuing-scoped-access.md).
