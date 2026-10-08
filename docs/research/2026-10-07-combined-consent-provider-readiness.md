# Combined consent provider readiness

Checked 2026-10-07 against current PostHog documentation and read-only configuration metadata for the existing Still App project. No customer events, profiles, recordings, conversations or report contents were queried; no provider setting changed.

The native integration uses the existing consent slot and the shared current permission schema. An old usage-sharing Boolean is not a current combined permission. A native write and readback prove storage; they do not prove that a provider can fulfill the disclosure or complete erasure.

## What the provider documentation establishes

- PostHog's person API exposes bulk deletion and a deletion-status read. This establishes an API surface, not completed deletion or selective erasure of one consent origin within a shared person. The selected adapter needs synthetic completion and scope evidence. [Persons API](https://posthog.com/docs/api/persons).
- Event retention follows the provider plan. The documentation explicitly distinguishes the query retention window from a deletion tool; it does not offer shortening the period as a deletion mechanism. A dashboard date filter cannot prove physical removal. Still's twelve-calendar-month requirement therefore needs a verified removal path, not a copied dashboard setting. [Events data retention](https://posthog.com/docs/data/events-retention), [controlling data storage](https://posthog.com/docs/privacy/data-storage#data-deletion).
- The Signals API documents report source metadata. Source metadata alone does not demonstrate deletion of prior conversations, reports, scout copies or other customer-derived outputs. That capability remains unverified. [Signals API](https://posthog.com/docs/api/signals-3).

## Actual configuration and remaining evidence

The existing Still App project was reachable through the read-only connector and reported IP anonymization enabled. These checks did not establish scoped erasure, identifiable retention, late-ingestion fencing, test exclusion or derived-output erasure. Another accessible project belongs to a separate application and is not a Still test environment.

Continue to use the existing `AnalyticsPrivacyPolicy` capability gate. Require actual evidence revisions for each capability before collecting under the new combined permission. Preserve the declined and unasked paths, immediate local withdrawal fencing, and independent free blocking, settings sync and purchase operations. No production collection or AI processing is activated by this source change.

Provider receipt, failed or pending deletion, and confirmed deletion must remain distinct. A successful test of the consent bridge is not provider or physical-device certification.
