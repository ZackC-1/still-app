import { readQaSandboxStripeWebhookRuntime, handleQaSandboxStripeWebhook } from "../_shared/qa-sandbox-stripe-webhook.ts";
const runtime = await readQaSandboxStripeWebhookRuntime(name => Deno.env.get(name));
Deno.serve(req => handleQaSandboxStripeWebhook(req, runtime));
