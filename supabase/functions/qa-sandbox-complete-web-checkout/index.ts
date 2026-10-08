import { readQaSandboxCheckoutRuntime, handleQaSandboxCheckoutUnavailable, handleQaSandboxCompleteCheckout } from "../_shared/qa-sandbox-checkout-runtime.ts";
const read = (name: string) => Deno.env.get(name);
const runtime = await readQaSandboxCheckoutRuntime(read);
Deno.serve(req => runtime ? handleQaSandboxCompleteCheckout(req,runtime) : handleQaSandboxCheckoutUnavailable(req,read));
