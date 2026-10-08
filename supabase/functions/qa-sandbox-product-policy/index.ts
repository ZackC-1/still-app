import { createQaSandboxPolicyHandler } from "../_shared/qa-sandbox-public-runtime.ts";

Deno.serve(createQaSandboxPolicyHandler((name) => Deno.env.get(name)));
