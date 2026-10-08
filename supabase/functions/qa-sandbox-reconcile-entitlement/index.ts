import { readQaSandboxRuntime, handleQaSandboxUnavailable, handleQaSandboxReconcile } from "../_shared/qa-sandbox-runtime.ts";
const read = (name: string) => Deno.env.get(name);
const runtime = await readQaSandboxRuntime(read);
Deno.serve(req => runtime ? handleQaSandboxReconcile(req, runtime.reconcile) : handleQaSandboxUnavailable(req, read, "reconcile"));
