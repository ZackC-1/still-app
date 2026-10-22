---
title: Apple canonical purchase analytics with originating-device consent
status: implementing-approved-contract
created: 2026-10-21
---

# Apple canonical purchase analytics

The parent and independent privacy reviewer approved this bounded contract on 2026-10-21. Implementation is under verification; no deployment is claimed. Base:
`bac1539f382798fa2ca812dd782beabc76c47b69`. The web increment is plan 003 and
migration 0028. This increment reserves migration 0029 after contract approval.

## Recommendation and contract decision

Let the server author the two existing canonical purchase events, and let the originating
Apple app transport those server results through its existing consent-fenced analytics client.
The server determines transaction eligibility, event name, stable UUID and event timestamp.
The client supplies only its existing permitted analytics envelope and current identity.
No private permission origin, erasure key, Apple transaction identifier, receipt, or purchase capability reaches PostHog. No anonymous ID reaches the new backend. The existing pseudonymous distinct ID reaches PostHog through the existing client transport and remains derived on device exactly as now.

This changes the current **transport** boundary: `isAppClientEvent` excludes both purchase
events today, including during queue validation. Ordinary `track`, UI analytics, content-script
bridges, and generic persisted events must continue rejecting them. A dedicated internal
canonical-result immediate transport is required, with strict descriptor validation and the same permission/account/erasure cancellation checks. Canonical results never enter the generic queue or a new persisted event queue. ADR 0004 and its producer description
must explicitly record this distinction before implementation. This is not permission to infer
a sale from `.purchased`, restore, account linking, or an entitlement snapshot.

Why not forward anonymous events directly from the server? Existing `originProof` is
SHA-256(erasureKey); the anonymous ID is HMAC-derived from that key. The server cannot derive
the ID from the proof. Sending the erasure key outside erasure, or accepting an arbitrary ID
that the server cannot tie to erasure, breaks the existing privacy contract. A new anonymous
identity issuer or cryptographic proof system is unnecessary for client transport.

## Original purchase provenance

1. Immediately before an actual native purchase attempt, capture the current analytics
   observation, confirmed identity scope, origin proof and project-key hash. No permission,
   unresolved identity, wrong analytics project or unsupported build means no analytics work;
   buying remains functional. A signed-out scope contains the existing anonymous index, not its ID.
2. A bounded optional `analytics-apple-purchase` prepare request creates a random 256-bit
   capability before the charge. Store only its hash. Preparation has a ten-minute expiry;
   timeout or failure skips analytics and does not prevent the purchase. The captured scope
   cannot be replaced by later opt-in. Do not initiate this request from restore or receipt refresh.
3. Native returns optional **new transaction provenance** only from the actual successful
   `Purchases.shared.purchase(package:)` branch. Its returned transaction identifier must match
   a locally verified StoreKit transaction for the expected product, purchased ownership and
   production environment. The verified preflight transaction identifier must differ. Existing
   owned/CustomerInfo short circuits return no provenance. Each coordinator consumes its completion once; the canonical transaction key makes duplicate waiters or retries share one immutable attribution.
4. Commit supplies that transaction's existing `AppleEvidence` and capability. The server reuses
   `AppleAccessVerifier.authenticate` and `refresh`, requires matching canonical identities,
   production/purchased/non-consumable/positive-paid evidence, and a purchase date within the
   prepared server interval. No backdating tolerance admits older purchases. Clock disagreement
   therefore omits optional analytics. A unique canonical transaction key admits one immutable
   original attribution. Replays cannot replace it; a newly prepared intent cannot claim an
   older transaction. Client success and first server observation alone are insufficient.
5. This intentionally omits Ask-to-Buy completions outside the bounded originating attempt,
   crash-before-binding, purchases made without original permission, old purchases and restores.
   It does not change RevenueCat identity, StoreKit purchase options or `appAccountToken`.

The Apple signature proves transaction facts, not which physical device pressed Buy. Matching
the actual native SDK result, verified preflight and server interval is the honest-app provenance
contract. It is not hardware attestation or proof against a modified client racing a copied,
fresh valid receipt. That stronger guarantee cannot be claimed without another approved design.

## Schema and API

`0029_apple_purchase_analytics.sql` adds private optional attribution storage, not a second
financial ledger. Proposed table `private.apple_purchase_analytics` contains:

- random capability hash, prepared/expires timestamps;
- existing hashed origin key, scope kind (`anonymous` or `subject`), anonymous index OR
  existing subject FK, project-key hash, original app surface/version;
- nullable unique canonical Apple transaction key until binding, the verified transaction ID
  needed for later provider refresh (private functional reference only), immutable purchased timestamp,
  confirmed full-refund timestamp, stable randomly generated UUID for each event;
- terminal retired state and no provider receipt, anonymous ID, email, account alias or erasure key.

The subject FK cascades on subject deletion. Anonymous rows never acquire an account/subject
later, including when functional purchase ownership is deliberately linked to an account.
Unbound expired intents are deleted by bounded maintenance. Bound attribution remains only as
long as 90 days from the original purchase, independently of the ten-minute intent deadline; device erasure
retires/removes optional attribution without removing retained financial rights/history. A narrow
0029 trigger on device-erasure job insertion/update retires matching attribution under the
existing origin lock; do not copy/replace the 0017 erasure function body. Existing terminal
retirement cannot be undone by job completion, cleanup or a retry.

The separate route has closed action bodies:

- `prepare`: originProof, projectKeySha256, scope (`anonymous` plus anonIndex, or `subject`),
  fixed Apple surface and appVersion. Subject scope resolves its identity from verified Auth,
  never a client-supplied subject. Anonymous scope has no account association.
- `commit`: capability, originProof, projectKeySha256, exact original scope, AppleEvidence.
  Canonical current evidence supplies all outcome facts. Invalid optional analytics cannot
  roll back, grant, revoke or otherwise change access fulfilment.
- `observe`: capability, originProof, projectKeySha256, exact original scope. The server
  refreshes the already-bound Apple transaction; it cannot bind a new transaction here.

Only fixed RPCs are granted to the narrow runtime role. Public/anon/authenticated SQL access
is revoked. Origin erasure shares migration 0017's advisory lock namespace/key. Subject
retirement, missing/deleted account, any device erasure job for the origin, retired attribution,
wrong project, environment or scope refuse both binding and result production. Checks occur
again after provider latency. Reuse rate limiting, bounded bodies and existing Apple verifier
timeouts; cap each response at two canonical events and never log capabilities or receipts.

The response is a closed versioned list of at most two server-authored descriptors:
`{uuid, event, timestamp, properties:{product,purchase_origin}}`, with fixed approved values.
No distinct ID or arbitrary property bag is accepted. HTTPS to the verified production origin
provides transport authenticity; this introduces no new signing protocol or trust key.

## Refund evidence and client dispatch

Current `VerifiedAppleTransaction` discards purchase/refund dates and collapses revocation into
`active: false`. Extend its verified facts narrowly; never treat `!active` as a refund. A
`purchase_refunded` descriptor requires canonical purchased ownership and explicit full-refund
evidence, with Apple's revocation timestamp. `REFUND_PRORATED`, `FAMILY_REVOKE`, unknown fields
and ambiguous legacy revocation omit refund analytics. Keep functional access semantics unchanged.
Apple documents distinct refund kinds and milliunit percentages; do not interpret 100 as 100%.

An ordinary originating-app foreground observes its locally retained capability only while the
original permission and exact identity scope remain current. Off, erasure, sign-in, sign-out,
account replacement/deletion, or anonymous-index advancement permanently drops that local
scope's capabilities; off/on cannot revive them. A signed-out
purchase cannot report later under an account or another anonymous index. A signed-in purchase
cannot report under another account or after sign-out. No StoreKit background notification or
server webhook sends optional analytics.

The local capability is stored outside synced settings, bounded to the product's current
attribution and bound to the original permission/scope. It is not a bearer entitlement and
cannot authorize purchases or access. Native and webview fence the scope before/after async
work. The client admits a descriptor only against the request's still-current captured
observation, never a freshly substituted identity. Delivery is immediate through the existing serialized transport; failures retry only on another ordinary originating-app foreground with the same local scope.
No `attributeLater` path applies to canonical results.

Stable server UUID, original event time and fixed identity make retry delivery idempotent.
A lost delivery response retries the same server UUID and timestamp on a fresh observation. A commit that never binds is omitted; a lost response after binding is recoverable without persisting Apple evidence. Sale precedes refund when both are first
observed together. The existing 30-day event age cap applies independently from original event time; old results
are omitted rather than retimestamped. Existing device erasure derives all anonymous indexes;
subject erasure covers signed-in events. Existing finite late-write sweeps cover already
in-flight sends. A fresh current-device request is still required for every new result; no
server-held consent lease is created.

## Exact implementation surfaces after approval

- Native: `apps/apple/Still/Shared (App)/Purchases/PurchaseManager.swift`,
  `apps/apple/StillKit/Sources/StillKit/ApplePurchaseCatalog.swift`, corresponding Swift tests.
  Keep modern optional provenance distinct from legacy purchase outcomes.
- App composition: `packages/core/src/native/bridge.ts`,
  `packages/core/src/ui/v3/apple-pro-host.ts` (host seam only),
  `packages/core/src/analytics/apple-app.ts`, new `apple-purchase-analytics.ts`,
  `packages/app-webview/src/main.ts`.
- Shared dispatcher: narrow canonical-result admission in `analytics/client.ts`, dedicated strict immediate descriptor validation, tests proving ordinary producers remain excluded.
  Web worker confirms it is not modifying client.ts or apple-app.ts; coordinate barrel exports.
- Backend: new `supabase/functions/analytics-apple-purchase/` handler/runtime/store,
  verified billing fields in `_shared/apple-access.ts`, migration 0029 and disposable DB tests.
  Reuse 0028's fixed PostHog properties, but do not modify its web dispatch route or SQL.
- Privacy/release docs: ADR 0004 producer/retention clarification and this plan. Parent/web worker
  owns deploy catalogue/tooling; agree handoff before adding the new function to deployment.

## Review gates and evidence required

Approved: the server-authored/client-transport boundary and its incomplete coverage.
No new event/property, anonymous-account alias, account-token change or private-key disclosure
is required. Server-only authority is preserved while the existing client transports anonymous results. Direct anonymous server emission is not used.

Tests must cover already-owned shortcuts, restored SDK transactions, same preflight ID, real
new canonical transaction, late/expired intent, duplicate waiters/replay, clock disagreement,
sandbox/Xcode/family ownership, paid and full/partial/ambiguous refunds. Exercise off during
every async boundary; off/on; sign-in/out; anon-index changes; account/device erasure; post-erasure
late commit; queue restart/tampering; provider timeout; stable UUID retry; and no identity
reattribution. Verify migration grants/RLS/locks against disposable PostgreSQL, Deno handlers,
Swift provenance seams, actual app host and shared consent/erasure tests.

Production delivery and refund evidence still require the final signed Apple build and genuine
provider evidence. A production-bound sandbox purchase also needs owner-approved sales-policy
admission while store release remains held: the review-issuance switch alone does not permit
the native pre-charge boundary. Before policy admission, configuration and negative paths are
the available evidence. This increment does not change those policy semantics.
Sandbox tests verify exclusion, not production analytics delivery. Conversion
reports remain a consented, device-return-dependent subset; Supabase/provider financial truth
continues independently.

References: existing plan 003; ADR 0004; migration 0017 derivation/erasure contract;
[Apple refund fields](https://developer.apple.com/videos/play/wwdc2025/249/);
[RevenueCat purchase result](https://www.revenuecat.com/docs/getting-started/making-purchases).

## Concrete bounds and maintenance

All actions consume a fixed per-network budget of 12 requests/minute before storage or provider calls. Missing trusted network identity refuses the request. Preparation additionally enforces two pending intents per origin and 2,048 globally, under a fixed SQL advisory lock. Request bodies are bounded. Final commit rechecks intent expiry and erasure after provider latency. Bound records remain available for refund observations after intent expiry.

The existing protected analytics-erasure `work` invocation runs a fixed 256-row optional cleanup independently of the PostHog deletion provider. Every preparation also cleans expired rows before enforcing the global ceiling. No new scheduler or financial deletion is introduced. Operational retention requires that existing maintenance continue running; no-return devices do not need to contact the app. Bound optional attribution is eligible for deletion at 90 days; client capabilities expire at 90 days. Refunds first observed after that lifetime are intentionally absent, even when their event date would otherwise be recent.

## Verification checkpoint

- 205 tests passed across canonical Apple transport, existing Apple account/consent lifecycle, native bridge decoding and actual purchase host composition. The broader run passed the remaining analytics suites; two existing account-switch tests exposed ten-millisecond detached-work assumptions under compiler load. Their assertions now wait for the same promised outcomes; no privacy assertion was removed.
- 38 Deno handler/erasure tests passed, including protected maintenance when the deletion provider is absent. Core TypeScript and app-webview Svelte checks passed; targeted ESLint passed.
- 15 Swift provenance/catalog tests passed. Full arm64 iOS simulator application compilation passed after building the webview resources; this is not final signed-device purchase proof. macOS compilation is in progress.
- The new real PostgreSQL test typechecks and is restricted to the existing disposable hosted runner. Actual migration/role/erasure/expiry proof remains pending that CI run. Parent/web workstream owns migration0029 deployment catalogue/invariants and the shared analytics deployment workflow.
- No production writes, provider purchases, store submissions or UI/visual edits were performed.

Independent review found a lock-order inversion in preparation cleanup. Preparation now obtains its origin lock before cleanup can acquire attribution row locks. The hosted PostgreSQL suite adds a genuine concurrent erasure/preparation regression with an expired row and a bounded erasure statement deadline. Existing Apple functional verifier/fulfillment/account suites passed 34 tests (68 steps), including generated-certificate full-versus-partial refund evidence.
