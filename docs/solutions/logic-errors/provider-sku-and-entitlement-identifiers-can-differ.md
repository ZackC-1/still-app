---
title: Preserve historical purchases when provider SKUs differ from entitlement identifiers
category: logic-errors
track: bug
problem_type: logic_error
module: supabase/functions/_shared/revenuecat-access.ts
applies_when: Preparing verified provider mappings for a new payment environment
date: 2026-10-21
status: active
tags: [revenuecat, entitlements, payments, migration]
---

# Provider SKUs and entitlement identifiers can differ

The V3 verifier required a legacy product's store identifier to equal its RevenueCat entitlement
lookup key. Synthetic tests used equal identifiers for every retained store. A read-only catalog
inspection exposed a real historical pair: Web Billing SKU `still_sync_web`, entitlement
`still_sync`. The valid production mapping would fail parsing, and omitting it would omit those
buyers' historical rights.

`parseAccessProductMappings` now accepts that exact pair only for `rc_billing`. The provider read
still checks the exact configured product ID, app ID, store, SKU, entitlement association, active
non-consumable product, environment and positive purchased lifetime evidence. The resulting Still
benefit comes from the validated entitlement lookup key, including on refunds. This does not
create a general alias mechanism or map old purchases to V3 extras.

Verification: the RevenueCat access and production checkout runtime suites pass (38 tests).
The historical-right test covers positive and refunded purchases with the actual SKU naming.
Negative tests reject the alias for Apple, a V3 entitlement, arbitrary suffixes and a mismatched
canonical catalog product. No production purchase records were modified to test this.

Before preparing production configuration, compare real provider identifiers with parser rules.
A new price or identical display name is not evidence that internal identifiers match. Preserve
separate provider and benefit identities and test known historical aliases explicitly.
