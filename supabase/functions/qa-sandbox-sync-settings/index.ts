import { createQaSandboxSyncHandler } from "../_shared/qa-sandbox-public-runtime.ts";

Deno.serve(createQaSandboxSyncHandler((name) => Deno.env.get(name)));
