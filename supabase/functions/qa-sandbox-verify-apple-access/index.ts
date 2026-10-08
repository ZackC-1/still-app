import { handleVerifyAppleAccess } from "../_shared/apple-fulfillment.ts";
import { readQaSandboxRuntime, handleQaSandboxUnavailable } from "../_shared/qa-sandbox-runtime.ts";
const read = (name: string) => Deno.env.get(name);
const runtime = await readQaSandboxRuntime(read);
Deno.serve(req => runtime ? handleVerifyAppleAccess(req, runtime.apple) : handleQaSandboxUnavailable(req, read, "apple-local"));
