import { readProductionCheckoutRuntime, handleProductionCheckout, handleProductionCheckoutUnavailable } from "../_shared/production-checkout-runtime.ts";
const read = (name: string) => Deno.env.get(name);
const runtime = await readProductionCheckoutRuntime(read);
Deno.serve(req => runtime ? handleProductionCheckout(req,runtime,false) : handleProductionCheckoutUnavailable(req,read));
