// Product policy wire format, shared by the public `product-policy` and the owner-only
// `product-policy-admin` functions (U6).
//
// The grammar is the shared one in packages/shared-types/src/product-policy.ts (#280), reused
// exactly: every body this server stores or serves is parsed with `parseProductPolicy` before it
// leaves this module. The server adds only the one canonical rendering (key order below, no
// whitespace), which migration 0016 renders identically in private.product_policy_render and
// requires byte-for-byte before it stores anything.
import {
  DEFERRED_PRODUCT_POLICY_SURFACES,
  parseProductPolicy,
  PRODUCT_POLICY_ENVIRONMENTS,
  PRODUCT_POLICY_SURFACES,
  type ProductPolicyEnvironment,
  type ProductPolicyNamespace,
  type ProductPolicySurface,
  type RatingPolicy,
  SALES_CHANNEL_BY_SURFACE,
  SALES_CHANNELS,
  type SalesPolicy,
} from "../../../packages/shared-types/src/product-policy.ts";

export type Policy = SalesPolicy | RatingPolicy;
export const PRODUCT_POLICY_NAMESPACES: readonly ProductPolicyNamespace[] =
  Object.freeze(["sales", "rating"]);
/** The largest revision a body can carry (the grammar's safe-integer bound). */
export const MAX_POLICY_REVISION = Number.MAX_SAFE_INTEGER;

export const isNamespace = (value: unknown): value is ProductPolicyNamespace =>
  typeof value === "string" &&
  (PRODUCT_POLICY_NAMESPACES as readonly string[]).includes(value);
export const isEnvironment = (
  value: unknown,
): value is ProductPolicyEnvironment =>
  typeof value === "string" &&
  (PRODUCT_POLICY_ENVIRONMENTS as readonly string[]).includes(value);
export const isRevision = (value: unknown, min = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min &&
  value <= MAX_POLICY_REVISION;

const ascii = new TextEncoder();

/** Parse stored or submitted body text with the shared grammar, bound to its namespace,
 * environment and (when given) revision. Null for anything the grammar or binding refuses. */
export function parsePolicyBody(
  namespace: ProductPolicyNamespace,
  environment: ProductPolicyEnvironment,
  body: string,
  revision?: number,
): Policy | null {
  try {
    const policy = parseProductPolicy(namespace, ascii.encode(body));
    if (policy.environment !== environment) return null;
    if (revision !== undefined && policy.revision !== revision) return null;
    return policy;
  } catch {
    return null;
  }
}

/** The canonical rendering of an already-parsed policy. */
export function canonicalPolicyBody(
  namespace: ProductPolicyNamespace,
  policy: Policy,
): string {
  const head =
    `{"schema":1,"environment":"${policy.environment}","revision":${policy.revision},`;
  const builds = `"builds":[${
    policy.builds.map((b) => `{"surface":"${b.surface}","build":"${b.build}"}`)
      .join(",")
  }]}`;
  if (namespace === "sales") {
    const sales = policy as SalesPolicy;
    const channels = SALES_CHANNELS.map((c) =>
      `"${c}":{"enabled":${sales.channels[c].enabled},"offer":"${
        sales.channels[c].offer
      }"}`
    ).join(",");
    return `${head}"salesEnabled":${sales.salesEnabled},"channels":{${channels}},${builds}`;
  }
  const rating = policy as RatingPolicy;
  const surfaces = PRODUCT_POLICY_SURFACES.map((s) =>
    `"${s}":${rating.surfaces[s]}`
  ).join(",");
  return `${head}"master":${rating.master},"surfaces":{${surfaces}},${builds}`;
}

const ENVELOPE_KEYS = ["schema", "environment", "revision"];

/** Turn an owner draft (the namespace fields only) into the canonical body for one environment and
 * revision. The draft may not carry the envelope; any other unknown key, wrong type, free string,
 * URL, escape or oversized result is refused by the shared grammar. */
export function renderDraft(
  namespace: ProductPolicyNamespace,
  environment: ProductPolicyEnvironment,
  revision: number,
  draft: unknown,
): string | null {
  if (
    draft === null || typeof draft !== "object" || Array.isArray(draft) ||
    Object.getPrototypeOf(draft) !== Object.prototype ||
    ENVELOPE_KEYS.some((key) => Object.hasOwn(draft, key)) ||
    !isRevision(revision, 1)
  ) return null;
  let candidate: string;
  try {
    candidate = JSON.stringify({ schema: 1, environment, revision, ...draft });
  } catch {
    return null;
  }
  const policy = parsePolicyBody(namespace, environment, candidate, revision);
  if (!policy) return null;
  const body = canonicalPolicyBody(namespace, policy);
  // The canonical text must itself be the same policy under the shared grammar.
  const again = parsePolicyBody(namespace, environment, body, revision);
  return again && canonicalPolicyBody(namespace, again) === body ? body : null;
}

/** Per surface: whether the REMOTE policy alone would allow it. For sales this is only the second
 * key; packaged builds AND it with their compiled switch, which this server never sees. Deferred
 * surfaces are always false. Owner view only; never served publicly. */
export function remoteSurfaceSummary(
  namespace: ProductPolicyNamespace,
  policy: Policy | null,
): Record<ProductPolicySurface, boolean> {
  const allowed = (surface: ProductPolicySurface): boolean => {
    if (!policy || DEFERRED_PRODUCT_POLICY_SURFACES.includes(surface)) {
      return false;
    }
    if (!policy.builds.some((b) => b.surface === surface)) return false;
    if (namespace === "rating") {
      const rating = policy as RatingPolicy;
      return rating.master && rating.surfaces[surface];
    }
    const sales = policy as SalesPolicy;
    const channel = SALES_CHANNEL_BY_SURFACE[surface];
    return sales.salesEnabled && channel !== null &&
      sales.channels[channel].enabled;
  };
  return Object.fromEntries(
    PRODUCT_POLICY_SURFACES.map((s) => [s, allowed(s)]),
  ) as Record<
    ProductPolicySurface,
    boolean
  >;
}

/** Read a request body of at most `max` bytes as strict UTF-8 JSON. Throws on anything else. */
export async function boundedJson(req: Request, max: number): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("request-shape");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) throw new Error("request-size");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** True for a plain JSON object with exactly these keys. */
export function exactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
