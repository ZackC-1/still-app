// Remote product policy grammar (U6). A closed, data-only description of the two remote
// namespaces Still may ever read: `sales` (whether a packaged, already-reviewed offer may start a
// purchase) and `rating` (whether a review prompt may be requested). Nothing here is ever
// evaluated as code, and nothing here can turn free blocking, free sync or Restore off.
//
// Dormant: no fetch, storage or caller is wired to this module yet. It is deliberately not
// re-exported from index.ts, so the Deno settings runtime graph is unchanged.
//
// Wire format: a deliberately restricted JSON. The body must be ASCII; strings contain no escape
// sequences; numbers are non-negative integers within the safe-integer range; object keys are
// unique; nesting is shallow. Anything else is invalid. These restrictions keep TypeScript and
// Swift (StillKit `ProductPolicy`) giving byte-for-byte identical verdicts, pinned by the shared
// vectors in packages/shared-types/fixtures/product-policy-vectors.json.
//
// To extend the grammar, add a field to SALES_POLICY_FIELDS or RATING_POLICY_FIELDS (and the Swift
// twin), add vectors, and bump nothing else. Never add free text, URLs, prices, thresholds,
// feature tiers, rule content or a switch for free blocking or sync.

export const PRODUCT_POLICY_SCHEMA = 1;
export const PRODUCT_POLICY_MAX_BYTES = 8192;
export const PRODUCT_POLICY_MAX_BUILDS = 32;
export const PRODUCT_POLICY_MAX_DEPTH = 4;
/** A fresh check counts only when consumed within this many milliseconds of its request start. */
export const PRODUCT_POLICY_FRESH_WINDOW_MS = 5000;

export const PRODUCT_POLICY_ENVIRONMENTS = Object.freeze(["sandbox", "production"] as const);
export type ProductPolicyEnvironment = (typeof PRODUCT_POLICY_ENVIRONMENTS)[number];

/** The fixed supported surface groups. Safari maps to its Apple host, never a second surface. */
export const PRODUCT_POLICY_SURFACES = Object.freeze([
  "chrome_desktop", "edge_desktop", "firefox_desktop", "firefox_android",
  "apple_mobile_host", "apple_macos_host",
] as const);
export type ProductPolicySurface = (typeof PRODUCT_POLICY_SURFACES)[number];

/** Remembered by the owner view but with no enabled launch producer: always inert. */
export const DEFERRED_PRODUCT_POLICY_SURFACES: readonly ProductPolicySurface[] = Object.freeze(["edge_desktop"]);

export const SALES_CHANNELS = Object.freeze(["apple", "web"] as const);
export type SalesChannel = (typeof SALES_CHANNELS)[number];
/** Packaged mapping from a surface to the only channel it may ever start a purchase through. */
export const SALES_CHANNEL_BY_SURFACE: Readonly<Record<ProductPolicySurface, SalesChannel | null>> = Object.freeze({
  chrome_desktop: "web", edge_desktop: null, firefox_desktop: "web", firefox_android: "web",
  apple_mobile_host: "apple", apple_macos_host: "apple",
});
/** Reviewed offers a channel may reference. A remote value outside this list is invalid. */
export const SALES_OFFERS = Object.freeze(["still-pro-v3"] as const);
export type SalesOffer = (typeof SALES_OFFERS)[number];

/** Packaged build identifiers: lowercase, no `:` or `/`, so never a URL. */
export const PRODUCT_POLICY_BUILD_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/;

export interface ProductPolicyBuild {
  readonly surface: ProductPolicySurface;
  readonly build: string;
}
interface PolicyEnvelope {
  readonly schema: 1;
  readonly environment: ProductPolicyEnvironment;
  /** Monotonically increasing, at least 1. Rollback republishes at a new revision. */
  readonly revision: number;
  readonly builds: readonly ProductPolicyBuild[];
}
export interface SalesPolicy extends PolicyEnvelope {
  /** The remote sales master. It is only ever one of two keys: see the core evaluator. */
  readonly paidTierEnabled: boolean;
  readonly channels: Readonly<Record<SalesChannel, { readonly enabled: boolean; readonly offer: SalesOffer }>>;
}
export interface RatingPolicy extends PolicyEnvelope {
  readonly master: boolean;
  readonly surfaces: Readonly<Record<ProductPolicySurface, boolean>>;
}
export type ProductPolicyNamespace = "sales" | "rating";

export class ProductPolicyGrammarError extends Error {
  constructor(readonly kind: "oversized" | "invalid") {
    super(kind === "oversized" ? "Oversized product policy" : "Invalid product policy");
    this.name = "ProductPolicyGrammarError";
  }
}
const invalid = (): never => { throw new ProductPolicyGrammarError("invalid"); };

// Restricted JSON tree. Objects are Maps so no key can reach a prototype.
type Json = null | boolean | number | string | readonly Json[] | ReadonlyMap<string, Json>;

function parseRestrictedJson(text: string): Json {
  let i = 0;
  const ws = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      i++;
    }
  };
  const expect = (char: string) => { if (text[i] !== char) invalid(); i++; };
  const string = (): string => {
    expect('"');
    const start = i;
    for (;;) {
      if (i >= text.length) invalid();
      const c = text.charCodeAt(i);
      if (c === 0x22) break;
      // No escapes, controls or non-ASCII: every legitimate key and value is plain ASCII.
      if (c === 0x5c || c < 0x20 || c > 0x7e) invalid();
      i++;
    }
    return text.slice(start, i++);
  };
  const value = (depth: number): Json => {
    if (depth > PRODUCT_POLICY_MAX_DEPTH) invalid();
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const map = new Map<string, Json>();
      ws();
      if (text[i] === "}") { i++; return map; }
      for (;;) {
        ws();
        const key = string();
        if (map.has(key)) invalid();
        ws(); expect(":");
        map.set(key, value(depth + 1));
        ws();
        if (text[i] === ",") { i++; continue; }
        expect("}");
        return map;
      }
    }
    if (c === "[") {
      i++;
      const items: Json[] = [];
      ws();
      if (text[i] === "]") { i++; return items; }
      for (;;) {
        items.push(value(depth + 1));
        ws();
        if (text[i] === ",") { i++; continue; }
        expect("]");
        return items;
      }
    }
    if (c === '"') return string();
    if (c !== undefined && c >= "0" && c <= "9") {
      const start = i;
      if (c === "0") i++;
      else while (i < text.length && text[i]! >= "0" && text[i]! <= "9") i++;
      const digits = text.slice(start, i);
      // A following '.', 'e' or digit after a leading zero fails at the caller's delimiter check.
      if (digits.length > 16) invalid();
      const number = Number(digits);
      if (!Number.isSafeInteger(number)) invalid();
      return number;
    }
    for (const [word, literal] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, i)) { i += word.length; return literal; }
    }
    return invalid();
  };
  const result = value(0);
  ws();
  if (i !== text.length) invalid();
  return result;
}

/** UTF-8 length without allocating for strings that are already too long. */
function utf8Length(text: string): number {
  if (text.length > PRODUCT_POLICY_MAX_BYTES) return text.length;
  return new TextEncoder().encode(text).length;
}

// Table-driven field validators. Each returns the frozen, validated value or throws.
type Field = (value: Json | undefined) => unknown;
const isMap = (value: Json | undefined): value is ReadonlyMap<string, Json> => value instanceof Map;
function exactObject(fields: Readonly<Record<string, Field>>): Field {
  const keys = Object.keys(fields);
  return value => {
    if (!isMap(value) || value.size !== keys.length || !keys.every(key => value.has(key))) invalid();
    const map = value as ReadonlyMap<string, Json>;
    return Object.freeze(Object.fromEntries(keys.map(key => [key, fields[key]!(map.get(key))])));
  };
}
const boolean: Field = value => typeof value === "boolean" ? value : invalid();
const oneOf = (allowed: readonly string[]): Field =>
  value => typeof value === "string" && allowed.includes(value) ? value : invalid();
const schema: Field = value => value === PRODUCT_POLICY_SCHEMA ? value : invalid();
const revision: Field = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : invalid();
const buildEntry = exactObject({
  surface: oneOf(PRODUCT_POLICY_SURFACES),
  build: value => typeof value === "string" && PRODUCT_POLICY_BUILD_PATTERN.test(value) ? value : invalid(),
});
const builds: Field = value => {
  if (!Array.isArray(value) || value.length > PRODUCT_POLICY_MAX_BUILDS) invalid();
  const entries = (value as readonly Json[]).map(item => buildEntry(item) as ProductPolicyBuild);
  if (new Set(entries.map(entry => `${entry.surface} ${entry.build}`)).size !== entries.length) invalid();
  return Object.freeze(entries);
};
const envelope = {
  schema,
  environment: oneOf(PRODUCT_POLICY_ENVIRONMENTS),
  revision,
  builds,
};
/** The complete closed sales grammar. Any other key anywhere is invalid. */
export const SALES_POLICY_FIELDS: Readonly<Record<keyof SalesPolicy, Field>> = Object.freeze({
  ...envelope,
  paidTierEnabled: boolean,
  channels: exactObject(Object.fromEntries(SALES_CHANNELS.map(channel =>
    [channel, exactObject({ enabled: boolean, offer: oneOf(SALES_OFFERS) })]))),
});
/** The complete closed rating grammar. Any other key anywhere is invalid. */
export const RATING_POLICY_FIELDS: Readonly<Record<keyof RatingPolicy, Field>> = Object.freeze({
  ...envelope,
  master: boolean,
  surfaces: exactObject(Object.fromEntries(PRODUCT_POLICY_SURFACES.map(surface => [surface, boolean]))),
});

/** Parse one namespace's body exactly. Throws ProductPolicyGrammarError; never returns a partial. */
export function parseProductPolicy(namespace: "sales", body: string): SalesPolicy;
export function parseProductPolicy(namespace: "rating", body: string): RatingPolicy;
export function parseProductPolicy(namespace: ProductPolicyNamespace, body: string): SalesPolicy | RatingPolicy;
export function parseProductPolicy(namespace: ProductPolicyNamespace, body: string): SalesPolicy | RatingPolicy {
  if (typeof body !== "string") invalid();
  if (utf8Length(body) > PRODUCT_POLICY_MAX_BYTES) throw new ProductPolicyGrammarError("oversized");
  const fields = namespace === "sales" ? SALES_POLICY_FIELDS : namespace === "rating" ? RATING_POLICY_FIELDS : invalid();
  return exactObject(fields)(parseRestrictedJson(body)) as SalesPolicy | RatingPolicy;
}
