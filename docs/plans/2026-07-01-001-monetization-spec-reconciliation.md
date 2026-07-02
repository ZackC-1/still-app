# Monetization Spec Reconciliation — Still-Spec-Monetization-Update vs. main (2026-07-01)

> **Status:** decisions ratified with the founder on 2026-07-01. This is the reconciliation plan the
> spec addendum (`~/Downloads/Still-Spec-Monetization-Update.md`, §0.3) requires before any build.
> Source spec assumed sync becomes free; the founder **amended the spec** on that point (see D1).
> Companion docs: `docs/monetization-design.md` (design, PR #22/#23) and `docs/Still-Spec-v1.md`.

## 1. Inventory — what already matches the spec (verified on main @ 307793a)

| Spec ask | State on main | Where |
|---|---|---|
| Free = YouTube Shorts only; IG/TikTok/FB Pro-gated | **Built.** Single `pro` engine gate; seed-tag-derived `PRO_SERVICE_IDS`; free/pro CSS split; always-free safety net for YT Shorts | `packages/core/src/rules/tiers.ts`, `engine.ts`, split CSS generator |
| Rules ship but are inert for free users; locked cards; contextual paywall trigger | **Built.** `isLocked` rows → `lockedTap()` → sign-in-first → paywall | `packages/core/src/ui/controller.svelte.ts`, `App.svelte` |
| $1.99 one-time non-consumable | **Built in code** (`displayPrice: 1.99`). Human tasks remain: ASC price tier + $2.99 metadata audit | `apps/apple/Still/Still.storekit` |
| Fail-safe entitlement (cached last-known-good, default-free) | **Built, stronger than spec:** tri-state read, 30-day TTL, server-authoritative, self-grant-proof | `packages/core/src/sync/`, `supabase/functions/` |
| Reuse RevenueCat (webhook/reconcile), restore, IAP-only on iOS (EU stance) | **Built.** `revenuecat-webhook`, `reconcile-entitlement`, `create-web-checkout` all exist server-side | `supabase/functions/` |

## 2. Ratified decisions (founder sign-off, spec §8 checklist)

- **D1 — Sync stays in Still Pro.** The spec's "sync becomes free" is **rejected**; the spec addendum
  is amended, not the build. Pro = IG/TikTok/FB blocking **+ cross-device sync**. Migration 0008
  (profiles-write-requires-entitlement), the `SyncService` entitled-gate, and current paywall copy
  ("…settings synced on every device") all stand. Consequence: spec §10.4 is moot — accounts are
  introduced at purchase; free users have no account-driven feature.
- **D2 — Build the full cross-platform purchase path in this release.** Chrome/Firefox extension
  auth + entitlement + RevenueCat Web Billing (Stripe-backed) checkout — the design doc's U10 + U8
  spine. `create-web-checkout` exists server-side and is currently unused by any UI.
- **D3 — Google sign-in deferred.** Extensions sign in via email magic link; Apple app keeps
  SIWA + magic link. Revisit alongside conversion data after web purchase ships.
- **D4 — Keep `still_sync` as the immutable internal id** (RevenueCat entitlement, DB column, RPC,
  StoreKit/ASC product id). "Still Pro" remains label-only. No schema rename, no migration.
- **D5 — Browsing nudge deferred.** No in-page upsell prompt this release.
- **D6 — Adopt the spec's paywall copy + add a success payoff state.** New copy: headline
  "The rest of the noise, gone too"; reassurance "One payment. Yours forever."; success state
  "Pro unlocked. Enjoy the quiet." with newly unlocked service rows visibly switching on before
  dismiss. Copy must be adjusted to still name sync as a Pro benefit (per D1) and stay launch-real
  (no YT recs/comments bullet). Anti-steering: never mention web pricing on Apple targets.
- **Confirmed assumptions:** one-time purchase (not subscription) — code and spec agree; pricing
  $1.99 everywhere; Apple IAP in-app on iOS/macOS, Web Billing only on true web surfaces (no EU
  external-link steering).

## 3. Build scope that falls out (for the next plan/work pass)

1. **Extension purchase spine (D2 — the big one):** popup sign-in (magic link) → Supabase session
   in the extension → authenticated `create-web-checkout` call → open hosted Web Billing checkout →
   reconcile-on-next-popup-open handoff → entitlement pull/cache in extension storage (signed-token
   model per monetization-design §6). Replace the "Chrome and Firefox unlock is on the way" copy.
2. **Paywall copy + success state (D6):** `strings.ts` rewrite + `PaywallSheet`/controller success
   flow (server-confirmed success → payoff moment → rows on → dismiss).
3. **Human/portal tasks (unchanged):** RC dashboard offering + Web Billing/Stripe product
   (`still_sync_web`, $1.99), ASC price tier, metadata audit, sandbox verification incl.
   cross-store double-charge guard and a self-grant attempt that must fail.

## 4. Known tension to keep visible

- The free tier's whole pitch is YouTube Shorts, and m.youtube.com blocking is broken on iOS Safari
  (issue #28, deferred to v1.1). The free promise is desktop-strong, mobile-Safari-weak at launch.
- Day-one Pro is re-partitioned existing features (IG/TikTok/FB + sync) — the design doc's §11
  "launch-value" concern stands; new YT surfaces (recs/comments/sponsored) remain future Pro value.
