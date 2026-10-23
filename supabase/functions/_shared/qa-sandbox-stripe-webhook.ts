import { readQaSandboxCheckoutRuntime, type QaSandboxCheckoutDeps } from "./qa-sandbox-checkout-runtime.ts";
import { QaSandboxManagedCheckout } from "./qa-sandbox-managed-checkout.ts";
import { handleManagedStripeWebhook, validManagedWebhookSecret } from "./managed-stripe-webhook.ts";

export interface QaSandboxStripeWebhookDeps {
  readonly secret: string;
  readonly checkout: QaSandboxCheckoutDeps;
  readonly refunds: Pick<QaSandboxManagedCheckout, "readChargeRefund">;
  readonly ownership: Pick<QaSandboxManagedCheckout, "readSessionOwnership">;
}
export async function readQaSandboxStripeWebhookRuntime(read: (name: string) => string | undefined): Promise<QaSandboxStripeWebhookDeps | null> {
  const secret = read("STILL_QA_SANDBOX_STRIPE_WEBHOOK_SECRET") ?? "";
  if (!validManagedWebhookSecret(secret)) return null;
  const checkout = await readQaSandboxCheckoutRuntime(read);
  return checkout?.billing instanceof QaSandboxManagedCheckout ? { secret, checkout, refunds: checkout.billing, ownership: checkout.billing } : null;
}
export function handleQaSandboxStripeWebhook(req: Request, deps: QaSandboxStripeWebhookDeps | null): Promise<Response> {
  return handleManagedStripeWebhook(req,deps ? { ...deps,checkout: { ...deps.checkout,environment: "sandbox" } } : null);
}
