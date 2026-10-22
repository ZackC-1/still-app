import { readProductionStripeWebhookRuntime, handleProductionStripeWebhook } from "../_shared/production-stripe-webhook.ts";
const runtime = await readProductionStripeWebhookRuntime(name => Deno.env.get(name));
Deno.serve(req => handleProductionStripeWebhook(req,runtime));
