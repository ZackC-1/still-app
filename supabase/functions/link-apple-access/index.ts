import { handleLinkAppleAccess } from "../_shared/apple-fulfillment.ts";
import { createAppleFulfillmentRuntime } from "../_shared/apple-access-runtime.ts";
const deps = await createAppleFulfillmentRuntime();
Deno.serve(req => handleLinkAppleAccess(req, deps));
