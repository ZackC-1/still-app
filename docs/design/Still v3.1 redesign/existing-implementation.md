# Existing implementation and remaining integration

Reconciled against main `e5b91f62` on October 7, 2026. The latest owner archive changes the visual authority. Existing implementations and their recorded checks remain the foundation.

| Area | Existing implementation to preserve | Remaining integration or verification |
| --- | --- | --- |
| Free blocking | Legacy and modern engines, supported-host consumers and browser fixtures | Latest UI, packaged candidates and device journeys |
| Account and free sync | Supabase OTP, two-client sync, retry, sign-out, deletion and account isolation | Authoritative account-confirmation projection, deletion outcomes and hosted modern readiness |
| Shared screens | D01/D02/D03/D04/D12/D14/D18/D20/D24/D25/D28/D29 components | Latest presentation changes and real host producers/routes |
| Apple purchases | Current lifetime product selection, historical Restore, receipt handling and RevenueCat identity infrastructure | Latest purchase screens, explicit linking, scoped fulfillment and configured sandbox/device evidence |
| Browser Restore | Existing check-only account flow and background reconcile | Preserve this flow; separately verify ownership and managed purchase/return integration |
| Consent and erasure | Per-device permission, account subjects, erasure handlers and migrations | Combined-purpose host/native producers, verified purpose policy and provider/deployment readback |
| Pro access | Twelve-benefit catalog, saved settings, consumers, verifier and access cache | Durable scoped issuance, transport and actual sandbox rights |
| Invitations and TikTok | Timing/hold policy, tab allowance and host adapters | Latest presentation, policy readiness and installed lifecycle proof |

Use the [curated V3 release record](../../release/history/v3/README.md), [product contract](../../PRODUCT.md), [architecture](../../ARCHITECTURE.md), and exact Git revision when evaluating existing work. Source presence, automated checks, configured build inputs, provider outcomes and physical-device acceptance are separate evidence. A passing component fixture cannot prove its real host operation; a missing host producer does not mean the underlying feature was never built.

The implementation plan's units describe bounded integration and verification work. Preserve existing successful QA within its recorded scope. The first foundation PR is [PR350](https://github.com/ZackC-1/still-app/pull/350); subsequent screen/account/provider work needs its own review and evidence.
