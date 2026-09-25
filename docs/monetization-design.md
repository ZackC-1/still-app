# Still — free release and retained monetization design

Current reference for 2.0.0; reviewed September 14, 2026. The
[product specification](PRODUCT.md) and [strategy](../STRATEGY.md) govern current access.
The [earlier design](archive/pre-2.0-reference-refresh/docs/monetization-design.md) preserves all
paid-era proposals, decisions and implementation history, including features that never shipped.

## Current access model

| Capability | Account | Payment |
|---|---|---|
| YouTube Shorts removal/redirection | Not required | Free |
| Instagram/Facebook Reels removal | Not required | Free |
| TikTok website blocking | Not required | Free |
| Local global/per-service settings | Not required | Free |
| Cross-device settings sync | Optional sign-in with the same account | Free |

Both compile-time constants are false: `PAID_TIER_ENABLED` in shared types and
`MonetizationConfig.paidTierEnabled` in StillKit. They cover engine access, packaged CSS, UI locks,
purchase presentation and native purchase/restore actions. The server free-sync migration is
`0012_profiles_write_free_sync.sql`. A slow or failed entitlement reconcile cannot delay free sync.
No checkout, restore, promotional grant, dummy entitlement or paid subscription is needed.

## What stays active

- Apple initializes the RevenueCat SDK anonymously and rekeys it to the Supabase account UUID on
  sign-in; sign-out/deletion resets that identity. Settings sync is independent of purchase rekeying.
- StoreKit receipt inspection and the App Group entitlement stamp remain. The source-aware
  never-downgrade rules are governed by [ADR 0003](adr/0003-entitlement-authority-receipt-and-server.md).
- `revenuecat-webhook` and `reconcile-entitlement` maintain historical account entitlements.
  Entitlement records are separate from client-writable settings. Browser extensions use Supabase
  and do not initialize a RevenueCat SDK.
- The immutable entitlement/Apple product is `still_sync`; the retained web product is
  `still_sync_web`. Preserve existing customer/product identities and restore behavior.
- The retained browser checkout function constructs the configured RevenueCat Purchase Link using
  the verified JWT subject. `REVENUECAT_WEB_PRODUCT_ID` is not read by the current implementation.
  The free client does not expose this checkout; disabled client UI does not delete the endpoint.

The previous signed entitlement-token proposal was deferred. The current browser cache is an
identity-bound record, not a claimed server-signed token. Rule-set signatures are a separate trust
mechanism. Retained entitlement cache/receipt semantics must not be confused with free-access rules.

## Prices and presentation

App-download pricing, in-app-product pricing, entitlement state and client feature gates are
separate. The September 14 [release snapshot](release/history/2026-09-14-release-status.md#store-snapshot)
records a free Apple download and the existing Apple product at zero price; it does not assert a
new Web Billing price or a live portal state checked during this documentation refresh.
Apple may retain an in-app-purchase label while the historical product exists. Reviewer notes explain
that no purchase is required. Preserve owner-edited portal descriptions and submitted screenshots.

The local `.storekit` fixture and historical price strings belong to dormant test/purchase paths;
they do not determine App Store Connect prices. Do not rename identifiers, delete the product or
rebuild a pending artifact to remove that history.

## Privacy, deletion and support

Use the [published privacy notice](https://stillapp.fit/privacy/) and
[retention runbook](release/counter-retention.md). Deleting a Still account removes active account,
settings and account-entitlement data; it does not automatically delete RevenueCat customers,
historical billing events, support mail or provider backups/logs. Those have the separately disclosed
handling. Do not represent anonymous SDK identifiers as “zero data” or purchase analytics as
advertising tracking without evidence of that use.

Prior web purchases use the approved 14-day refund window. Apple handles Apple refunds.
`support@stillapp.fit` handles receipt/refund questions. A former buyer does not need purchase
recovery to use any 2.0.0 feature.

## Future paid release

Changing either flag is a new product/release decision. A future reactivation must coordinate both
client flags, server sync permissions, current pricing/offerings, UI/metadata/privacy, receipt and
account identity, checkout/restore/refund paths, offline behavior and actual store/device tests.
The June/July feature proposals for recommendations, comments, sponsored content and granular
controls are not implemented promises of this release.

Use the [RevenueCat runbook](release/04-revenuecat.md) for retained configuration and historical
purchase checks. Do not run that historical purchase program as a prerequisite for free activation.
