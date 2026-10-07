# Facts to establish before delivery

These are outstanding implementation or verification obligations, not approved omissions. Independent work continues while their dependent acceptance remains open.

| Fact | Required evidence | Owning plan unit |
|---|---|---|
| Reachable TestFlight test backend | Owner selected existing hosted backend with dedicated test accounts; verify matching modern migrations/functions and sandbox fulfillment, with no sandbox-to-production grants | U3/U11 |
| Managed-only web purchase capability | Selected provider test checkout cannot fall back to an unapproved unmanaged flow; authoritative return/ownership proof | U7 |
| Apple offer and scoped rights | Actual localized StoreKit/RevenueCat offer, sandbox purchase/Restore, environment-bound signed fulfillment | U5/U6 |
| Explicit account association/transfer | Intended-account confirmation, fresh authority for both accounts on transfer, conflict/retry; local Apple rights preserved | U4/U6 |
| Combined consent purposes/providers | Verified production purposes and identity handling; fresh combined permission distinct from old consent answer | U4/U9 |
| Deletion/erasure status | Server account result separately from analytics erasure requested/pending/completed; real provider readback where required | U4 |
| Protected benefit cutoff and owner allowances | Reviewed historical classification, frozen snapshot, owner authorization and preview/apply/readback; no production sales enablement inferred | U5/U10 |
| Safari Pro app route | Trusted fixed destination; native cold/warm routing, popup failure/recovery and unsupported-host behavior | U6 |
| Platform setup/support destinations | Actual URLs and permission/setup behavior, including iOS uncertainty and Firefox Android capabilities | U8/U9/U10 |
| Wordmark | Decode-valid central production asset derived from verified brand artwork; original corrupt asset remains excluded | U2 |
| Exact visual baselines | DOM-derived frames/captions, engine/font/version receipt; references mandatory for release gate | U2/U11 |
| Physical device/surface coverage | Real iPhone/iPad/macOS Safari and Firefox Android evidence; simulator/Chromium framing does not replace device proof | U11 |
| Persistent Firefox QA installation | Unlisted signed XPI, paired reproducible source/hashes, desktop/Android installation and restart/permission evidence; source ZIP alone is insufficient | U11 |

Current readiness is source-audited only. No provider configuration, deployed backend behavior, payment transaction or device completion is claimed by this reference intake.

Read-only hosted inspection on2026-10-07: Auth health returned200; product-policy route returned404. Deployed-function inventory contains retained auth/deletion/reconcile/checkout/analytics functions, but does not list sync-settings, product-policy or its admin handler. This identifies deployment work; it does not establish why the route is absent or prove provider readiness. No hosted state was changed.
