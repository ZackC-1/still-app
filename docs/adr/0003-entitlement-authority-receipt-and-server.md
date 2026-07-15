# ADR-0003: Entitlement has two authorities — the StoreKit receipt and the server

Date: 2026-07-15 · Status: accepted

## Context

App Review rejected macOS 1.0 (3) under Guideline 5.1.1(v): email registration was required before
purchasing the non-account-based Still Pro IAP. The requirement was structural (KTD5 keyed
RevenueCat to the Supabase UUID before any purchase; the App Group entitlement stamp was written
only from server-reconciled state; a voluntary sign-out stamped `entitled:false`). Purchase-first
compliance needs an entitlement source that exists with no account.

The architecture-deepening review (docs/plans/2026-07-14-001-architecture-deepening-index.md,
candidate 5) had already flagged the never-downgrade entitlement rules as duplicated across the two
session orchestrators, and the user deferred consolidating them pre-release.

## Decision

1. **Two entitlement authorities.** The server (RevenueCat webhook → Supabase → reconcile) decides
   what the ACCOUNT owns — unchanged, and still the only authority browser surfaces have. On Apple
   platforms the device's StoreKit 2 receipt additionally decides what the DEVICE owns: read via
   `Transaction.latest(for:)` (NOT `currentEntitlements`, which hides revoked transactions and
   would make refunds unobservable), tri-state — `entitled` / `verifiedNotEntitled` (revocation
   observed) / `noSignal` (absence, cold cache, offline, timeout).

2. **One enforcement home for the App Group stamp.** Every stamp write routes through
   `StampPolicy` (StillKit, pure, swift-test covered), seated inside `EntitlementBridge`'s set
   path — NOT the router, because `SafariWebExtensionHandler` routes raw entitlement messages
   through its own bridge instance and would bypass a router-seated gate. The extension handler's
   lane is additionally read-only: the extension process has no receipt oracle, and a writable
   lane would be an entitlement-forgery surface.

3. **Source-aware never-downgrade matrix.** The stamp records its authority
   (`source: receipt | server`; legacy stamps decode as server). True writes always land. False
   writes land only when: the live receipt is `entitled` → never (blocked AND restamped
   receipt-true); `verifiedNotEntitled` → the server lane may downgrade anything, the receipt lane
   only receipt-source stamps (a refunded Apple purchase must not clobber web-granted Pro);
   `noSignal` → only server-lane over server-source stamps (account-derived Pro leaves with the
   account — the ratified shared-machine sign-out invariant — while ambiguity never downgrades
   receipt-proven Pro).

4. **The receipt status provider is a cached snapshot** (StoreKit reads are async; the bridge's
   set path is sync), refreshed at launch, foreground, post-purchase, post-restore, and before
   teardown proposals — with a blocked-write re-read: a false proposal blocked on cached
   `entitled` triggers a fresh read and re-proposal, so a mid-session refund converges within one
   re-read.

5. **Three-authority layering is deliberate.** "One home" applies to the App Group stamp. The
   Safari extension's 30-day TTL and install-generation purge remain separate, intentional
   downgrade authorities on its DERIVED browser.storage copy — the TTL bounds offline staleness by
   design. Do not consolidate them into StampPolicy.

6. **Candidate 5 stays deferred.** This ADR implements the Apple half only; the extension-session
   orchestrator is untouched (coherent: browser surfaces have no device receipt, so the server
   remains their sole authority and their teardown purge semantics stay correct). The
   cross-orchestrator consolidation remains a post-release candidate.

## Consequences

- A signed-out purchaser has full Pro on the device (app + Safari extension) with zero personal
  information; optional sign-in attaches the purchase via RevenueCat's ID-level merge and the
  existing webhook/reconcile spine distributes it (the attach evaluation runs at every session
  establishment and foreground, gated natively on SDK-identity equality and purchased — not
  family-shared — ownership).
- `updatedAt` on the stamp now means "last time ANY authority confirmed" (header contracts in
  `EntitlementBridge.swift` and `packages/ext-safari/lib/entitlement-pull.ts` updated).
- Two accepted 30-day staleness bounds (documented in the release runbook's support notes): a
  refunded user who never opens the app keeps Safari Pro until the stamp's TTL lapses; a
  Safari-only user who never launches the app for 30 days re-locks until they open it. The
  in-extension receipt refresh that would remove both bounds is a recorded follow-up.
- The macOS deployment target rose to 12.0 (StoreKit 2's floor; zero production users existed).
