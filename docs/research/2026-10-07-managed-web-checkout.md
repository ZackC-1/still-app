# Managed web checkout verification

Verified October 7, 2026 against primary provider documentation. This is implementation research, not proof that the Still account or product is configured.

RevenueCat supports three web billing engines. RevenueCat Billing uses Stripe as a gateway while the seller remains merchant of record. Stripe Billing can use Stripe Managed Payments; Paddle Billing uses Paddle as merchant of record. A hosted Purchase Link alone does not establish the selected engine or managed eligibility. [RevenueCat web overview](https://www.revenuecat.com/docs/web/overview), [Purchase Links](https://www.revenuecat.com/docs/web/web-billing/web-purchase-links).

The Stripe Billing integration requires updated app permissions, an eligible enabled Stripe account, and eligible product tax categories. RevenueCat explicitly documents a fallback to ordinary unmanaged checkout when an offering contains an ineligible product. Its configuration checkbox therefore cannot alone satisfy Still's managed-only requirement. A ready channel needs an enforceable provider contract for the exact product, environment and actual checkout. [RevenueCat Managed Payments](https://www.revenuecat.com/docs/web/integrations/stripe/stripe-managed-payments).

Testing uses the selected engine's matching sandbox configuration. Sandbox purchase links must remain inside the dedicated QA lane and must not grant production rights. [RevenueCat testing](https://www.revenuecat.com/docs/web/web-billing/testing).

The retained Still `RevenueCatWebPurchaseLink` constructs a JWT-subject-bound hosted URL. Reuse its account-binding safeguards where applicable, but do not treat this URL or a successful redirect as evidence of managed checkout or scoped ownership. Provider capability, real test purchase, fulfillment and return observation remain required.
