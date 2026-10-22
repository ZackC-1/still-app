# Still purchase identifiers and compatibility

Current source reference, reviewed October 22, 2026. The [strategy](../STRATEGY.md) and
[product specification](PRODUCT.md) govern access and pricing. Shipped 2.x keeps paid behavior
dormant; V3 adds the approved optional Still Pro extras. Free blocking and settings sync never
require a purchase. Sign-in is optional and enables settings sync.

The [earlier design](archive/pre-2.0-reference-refresh/docs/monetization-design.md) preserves
paid-era proposals and implementation history. The [RevenueCat runbook](release/04-revenuecat.md)
separately labels the 2.x checkpoint and historical setup procedures.

## Purchase identifiers

Use this table when documenting the catalog. These are distinct records, not alternative names
for one product. Preserve historical identifiers and customer rights.

| Record | Identifier | Purpose |
|---|---|---|
| V3 Apple product and RevenueCat entitlement | `still_pro_v3` | The current V3 purchase catalog. |
| V3 RevenueCat offering / package | `still_pro_v3` / `$rc_lifetime` | The exact lifetime offer selected by the Apple catalog. |
| Historical Apple product and RevenueCat entitlement | `still_sync` | Existing purchases and restore compatibility. Do not rename or repurpose. |
| Historical RevenueCat Web Billing product | `still_sync_web` | Maps to the historical `still_sync` entitlement. |
| V3 web purchase | Environment-specific Stripe price mapped to `still_pro_v3` | The backend validates the exact configured price; do not substitute a historical Web Billing product. |
| Historical Supabase entitlement projection | `entitlements.still_sync` / TypeScript `stillSync` | Retained data compatibility; not a requirement for free blocking or sync. |

The source of truth for Apple product, entitlement and offering selection is
[ApplePurchaseCatalog](../apps/apple/StillKit/Sources/StillKit/ApplePurchaseCatalog.swift).
The backend's [provider mapping parser](../supabase/functions/_shared/revenuecat-access.ts)
defines accepted V3 and historical mappings. The owner's October 21 decision to keep the new
product separate from the historical purchase is recorded in the
[production activation record](plans/2026-10-21-002-production-activation-and-verification.md).
This table describes the source contract, not a fresh verification of provider dashboards.

## Access and purchase authority

Both paid-tier flags remain false in this reviewed main: `PAID_TIER_ENABLED` in shared types and
`MonetizationConfig.paidTierEnabled` in StillKit. V3 release activation must coordinate the client
flags, catalog, backend, disclosures and verification. Turning on paid extras must never restore
the historical paid-sync gate; migration `0012_profiles_write_free_sync.sql` removed it.

Settings and purchase authority remain separate. Apple supports device-owned purchases and
Restore without sign-in; account linking and browser access follow their own authority rules.
Use [ADR 0003](adr/0003-entitlement-authority-receipt-and-server.md), its
[V3 purchase-flow amendment](adr/0005-apple-still-pro-purchase-starts-with-sign-in.md), and the
[architecture's entitlement flow](ARCHITECTURE.md#entitlement-flow-dormant-in-shipped-2x-active-under-v3).
Keep historical receipt and account mappings when changing V3 wiring.

V3's signed paid-access deadlines are distinct from the historical entitlement cache and from
rule-set signatures. The [V3 release record](release/history/v3/README.md) defines the offline
access contract. The retired RevenueCat Purchase Link design is historical; use the
[production activation plan](plans/2026-10-21-002-production-activation-and-verification.md)
for the current managed-checkout work and its remaining verification gates.

## Release and support references

App-download prices, in-app-product prices, feature flags and entitlement records are separate.
A dated zero-price observation or local StoreKit fixture does not establish a current store price.
Do not rebuild a submitted artifact merely to synchronize it with later source or documentation.

Use [the product specification](PRODUCT.md) for free access and Pro behavior, the
[retention runbook](release/counter-retention.md) for account and provider deletion boundaries,
and [the release overview](release/README.md) for dated release evidence. Historical purchase
checks are not prerequisites for free activation.
