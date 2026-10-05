// Public product policy read (U6). One fresh, uncached answer to "what is the current remote policy
// for this namespace and environment?" for packaged clients that are about to decide whether a
// purchase may start or a review prompt may be requested.
//
// Request: POST {"namespace":"sales"|"rating","environment":"sandbox"|"production"} and nothing
// else (no query string, no other key). No account, device, install or analytics identifier is
// read or needed, and nothing about the request is logged.
//
// Response: 200 with exactly the stored policy body (restricted ASCII JSON in the shared grammar)
// when a policy exists; 404 with no body when none exists, which clients treat as Off (owner
// question 5: no row means Off); 400 for a malformed request; 503 with no body when storage is
// unavailable or a stored body no longer parses, which is also Off. Every response is
// `Cache-Control: no-store`. The body never carries revision metadata beyond its own `revision`,
// nor any operation, owner, ledger or cutoff data.
//
// Signing seam (owner question 4: no signing yet; TLS plus fresh-only reads). A later
// configuration-signing purpose, separate from the rule key and the paid-proof key, would add one
// detached signature header over the exact body bytes in `policyResponse`. The body bytes and
// status codes stay as they are, so clients that do not yet verify keep working.
import { corsHeaders, optionsResponse } from "../_shared/store.ts";
import {
  boundedJson,
  exactKeys,
  isEnvironment,
  isNamespace,
  parsePolicyBody,
} from "./policy-wire.ts";
import type {
  ProductPolicyEnvironment,
  ProductPolicyNamespace,
} from "../../../packages/shared-types/src/product-policy.ts";

/** Server-only read port. The Postgres implementation connects as still_policy_reader. */
export interface PolicyReader {
  read(
    namespace: ProductPolicyNamespace,
    environment: ProductPolicyEnvironment,
  ): Promise<string | null>;
}

export interface ProductPolicyDeps {
  readonly reader: PolicyReader;
}

const MAX_REQUEST = 256;
const NO_STORE = {
  ...corsHeaders,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function empty(status: number): Response {
  return new Response(null, { status, headers: NO_STORE });
}

/** The single place a policy body leaves the server. */
function policyResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { ...NO_STORE, "content-type": "application/json" },
  });
}

export async function handleProductPolicyRead(
  req: Request,
  deps: ProductPolicyDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return empty(405);
  if (new URL(req.url).search !== "") return empty(400);
  let request: unknown;
  try {
    request = await boundedJson(req, MAX_REQUEST);
  } catch {
    return empty(400);
  }
  if (!exactKeys(request, ["namespace", "environment"])) return empty(400);
  const namespace = request.namespace;
  const environment = request.environment;
  if (!isNamespace(namespace) || !isEnvironment(environment)) return empty(400);
  let body: string | null;
  try {
    body = await deps.reader.read(namespace, environment);
  } catch {
    // Fixed text only: storage errors are never echoed or logged with their details.
    console.error("product policy read unavailable");
    return empty(503);
  }
  if (body === null) return empty(404);
  // Never serve a body the shared grammar refuses: a client would read it as Off anyway.
  if (!parsePolicyBody(namespace, environment, body)) return empty(503);
  return policyResponse(body);
}
