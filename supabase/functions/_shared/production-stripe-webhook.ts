import { readProductionCheckoutRuntime } from "./production-checkout-runtime.ts";
import { ManagedCheckout } from "./managed-checkout.ts";
import { handleManagedStripeWebhook, validManagedWebhookSecret, type ManagedStripeWebhookDeps } from "./managed-stripe-webhook.ts";

export async function readProductionStripeWebhookRuntime(read: (name: string) => string | undefined): Promise<ManagedStripeWebhookDeps | null> {
  const secret = read("STRIPE_WEBHOOK_SECRET") ?? "";
  if (!validManagedWebhookSecret(secret)) return null;
  const runtime = await readProductionCheckoutRuntime(read);
  if (!runtime || !(runtime.billing instanceof ManagedCheckout)) return null;
  return { secret,checkout: { ...runtime,operations: runtime.operationStore() },refunds: runtime.billing };
}
export function handleProductionStripeWebhook(req: Request, deps: ManagedStripeWebhookDeps | null): Promise<Response> {
  return handleManagedStripeWebhook(req,deps?.checkout.environment === "production" ? deps : null);
}
