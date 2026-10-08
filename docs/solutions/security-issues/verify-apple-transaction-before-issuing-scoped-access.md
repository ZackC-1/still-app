---
title: Verify Apple transactions and bind native rights before issuing scoped access
category: security-issues
track: bug
problem_type: security_issue
module: supabase/functions
applies_when: A native StoreKit JWS is exchanged for signed local or account access
date: 2026-10-07
status: active
tags: [apple, entitlement, signatures, ownership, native]
---

# Verify Apple transactions and bind native rights before issuing scoped access

A device can submit a previously valid purchase transaction after a refund. Decoding its JWS,
trusting the certificate embedded in its header, or accepting a native Boolean would permit
forged or stale ownership to renew a signed access clock. A separate problem arises when an
opaque random right reaches JavaScript: a valid scoped proof has no Apple transaction identifier,
so JavaScript cannot establish which independently verified StoreKit transaction owns that right.

Use [Apple's maintained App Store Server Library](https://github.com/apple/app-store-server-library-node)
with explicit [Apple PKI roots](https://www.apple.com/certificateauthority/), online certificate
checking and the configured app/environment. Permit only ES256, then validate the verified
bundle, product, lifetime type, ownership, timestamps and paid evidence. A verified Family Sharing
transaction can establish local possession; it cannot link or transfer an account. Keep Apple
transaction identifiers as strings. A fresh `getTransactionInfo` response, independently verified
as another Apple JWS, must match the original transaction before renewing access. A failed or stale
lookup is ambiguity; it must not prove absence or extend the deadline.

[apple-access.ts](../../../supabase/functions/_shared/apple-access.ts) performs those checks.
Its runtime factory has no Xcode/local-testing fallback, request-selected environment or
request-provided trust anchor. [Apple's payload reference](https://developer.apple.com/documentation/appstoreserverapi/jwstransactiondecodedpayload)
explains the ownership, original transaction, signed date and revocation fields.

The runtime matters. Supabase's published
[Edge X.509 implementation](https://raw.githubusercontent.com/supabase/edge-runtime/v1.74.3/ext/node/polyfills/internal/crypto/x509.ts)
leaves certificate `verify`, `raw`, `infoAccess` and `toString` unimplemented. Apple's Node
crypto path calls these methods; passing tests on a newer local Deno does not establish Edge
compatibility. [apple-edge-verifier.ts](../../../supabase/functions/_shared/apple-edge-verifier.ts)
overrides Apple's supported protected `verifyJWT` seam while keeping its public transaction
validator and app/environment checks. It uses maintained PKI.js/ASN1.js parsing and native
WebCrypto signatures through JOSE. There is no global crypto patch or bespoke certificate parser.

The adapter pins the complete three-certificate chain to the packaged Apple roots, validates
certificate path, constraints, key usage, Apple OIDs and dates, and requires current good OCSP
for leaf and intermediate. [PKI.js 3.4.1](https://github.com/PeculiarVentures/PKI.js/releases/tag/v3.4.1)
includes issuer-bound responder authorization: chaining to a trusted CA alone does not grant
OCSP signing authority. BasicOCSPResponse certificates are optional for direct issuer signatures:
include the already verified issuer among bounded signer candidates, without trusting arbitrary
responders. Require the matching certificate ID, valid responder signature and
fresh `thisUpdate`/`nextUpdate`. Request no nonce, matching Apple's verifier. Native fetch
allows only explicit Apple OCSP/API hosts, rejects redirects, and bounds response bytes and
latency. The API bearer uses WebCrypto ES256 and Apple's read-only transaction-info endpoint.

The issuer signs a second closed envelope under `still-apple-right-binding-v1\n`, separate from
`still-access-proof-v1\n`. Its canonical payload names the environment, bundle, product,
original transaction, random right, ownership revision and identical proof clock. The native
consumer must verify both signatures and compare the binding with its own current verified
StoreKit transaction before registering the random local right. A signed local proof alone
cannot authorize that mapping. The local proof's holder equals its right; an account proof's
holder is the confirmed authenticated account.

Explicit account linking derives destination authority from the verified account token. A transfer
requires the source account's independently verified token as well. Recheck both accounts after
provider latency; compare ownership revision and operation scope in the server ledger; confirm
current ledger state after signing. Account failures must leave independently verified local
purchase rights intact. Ordinary settings sign-in must not initiate purchase linking.

Current Apple Pro transactions have one Apple original-transaction authority. RevenueCat's
`purchase.id` is a separate identity; do not mint another current Apple right from it. A RevenueCat
account snapshot cannot revoke independently verified Apple rows or renew their verification
clock. [apple-account-access.ts](../../../supabase/functions/_shared/apple-account-access.ts)
refreshes only already-linked private Apple identities with current canonical API verification before
account reconciliation signs them. A verified refund updates the same right and revision; missing
provider configuration or ambiguous verification withholds issuance. Legacy and web right paths
retain their separate verified contracts. Missing or partial provider lists cannot revoke unobserved
transactions or renew their clocks. Sign only current observed rows that match the committed
holder, revision and verification time. A refund as the first canonical Apple observation must
persist a negative tombstone so a delayed active receipt cannot resurrect its placeholder.

Independent lookups must settle before reading known removals. A failed lookup on one linked
transaction cannot suppress another transaction's verified refund. The authenticated reconciliation
transport permits a closed removal-only `unavailable` envelope with empty proofs and bounded
right/revision removals. Read these through the narrow account/environment/current-token RPC;
this read grants nothing, renews no clock, and infers no absence. Clients apply admitted removals
under their captured account/generation fence while preserving unknown readiness and unrelated
rights. The positive-grant deadline does not limit this removal-only read.

Reconciliation request bodies have a whole-read two-second deadline and 4096-byte bound. Cancel
stalled or oversized input without awaiting a hostile stream's cancellation promise. Incomplete
or errored input returns the closed invalid-request response before provider work; completed
legacy bodies retain their existing behavior.

## Verification

[apple-access.test.ts](../../../supabase/functions/_shared/apple-access.test.ts) generates test
certificate chains and real ES256 JWS signatures. It accepts the explicitly trusted synthetic
chain and rejects the same Apple-named counterfeit chain against the packaged Apple roots,
modified payloads and absent chains. It also checks current refund, stale canonical observations,
app/product/environment fences, Family Sharing and numeric-ID precision. The production verifier
retains online checks; the synthetic chain test deliberately uses its own root and offline checks.

[apple-edge-verifier.test.ts](../../../supabase/functions/_shared/apple-edge-verifier.test.ts)
additionally generates real certificate/JWS/OCSP signatures with WebCrypto. It verifies direct
and delegated responder authority and rejects revoked, stale, unknown, forged and mismatched
responses. The default OCSP path succeeds with all affected Node X.509 methods disabled in
the test. This establishes the adapter's independence from those methods, not hosted execution.

Replacing official signature verification with payload decoding makes three attack regressions
fail: counterfeit roots, altered payloads and missing chains. Restoring the verifier makes the
suite pass. [access-issuer.test.ts](../../../supabase/functions/_shared/access-issuer.test.ts)
verifies the actual Ed25519 binding signature, payload order, identical clock and purpose separation.
[apple-fulfillment.test.ts](../../../supabase/functions/_shared/apple-fulfillment.test.ts)
checks both account authorities, intended-account fencing, lost confirmation, conflicting ownership
and partial/stalled request rejection.

These cryptographic and handler tests do not certify Apple provider configuration, deployed SQL,
sandbox purchases, native installation or physical-device behavior. The guarded
[ledger probe](../../../supabase/tests/apple_scoped_access_test.ts) runs only in the disposable
hosted Supabase rehearsal described by [the backend runbook](../../../scripts/backend/README.md).
