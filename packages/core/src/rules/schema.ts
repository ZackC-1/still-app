import {
  RULE_ACTIONS,
  type RuleAction,
  type SignedRuleSet,
  SURFACE_TIERS,
  SURFACE_CAPABILITIES,
  type SurfaceCapability,
  type SurfaceTier,
  FEATURE_REGISTRY,
  SERVICE_IDS,
  TIKTOK_ALIAS,
  type SignedRuleSetV2,
} from "@still/shared-types";
import { VERSION_RE } from "./version.js";

// Structural + safety validation for rule sets (KTD13). This is the security boundary between
// "data the packaged interpreter accepts" and "anything that could change control flow or
// exfiltrate". It rejects unknown fields, non-enum actions, malformed URL rules, and unsafe CSS.
// It does NOT verify the cryptographic signature — that is signature.ts.

export type ValidationResult =
  | { readonly ok: true; readonly value: SignedRuleSet }
  | { readonly ok: false; readonly errors: readonly string[] };

const MAX_SELECTOR_LEN = 512;
const MAX_PATTERN_LEN = 256;

const SURFACE_KEYS = new Set([
  "id",
  "label",
  "tier",
  "requiredCapability",
  "action",
  "enabledByDefault",
  "selectors",
  "redirect",
  "urlMatch",
]);
const REDIRECT_KEYS = new Set(["urlMatch", "to", "fallbackToPlaceholder"]);
const SERVICE_KEYS = new Set(["matches", "surfaces"]);
const SIGNATURE_KEYS = new Set(["kid", "alg", "value"]);
const TOP_KEYS = new Set(["version", "services", "signature"]);

/** Pseudo-classes permitted in selectors. Everything else (e.g. :visited, :hover) is rejected. */
const ALLOWED_PSEUDOS = new Set(["not", "is", "has", "where"]);

/** Substrings that must never appear in a selector — CSS exfiltration / injection vectors. */
const FORBIDDEN_SELECTOR_TOKENS = [
  "url(",
  "@import",
  "expression(",
  "javascript:",
  "/*",
  "*/",
  "</",
  "{",
  "}",
  ";",
  "\\",
  "::", // pseudo-elements (::before content side channels) are out of scope
];

/** Characters allowed in a selector after the forbidden-token and pseudo checks. */
// `/` is allowed (appears in href attribute values like [href*="/reel/"]); the `/*` and `*/`
// comment sequences are already rejected by FORBIDDEN_SELECTOR_TOKENS above.
// `?` allows href query-string guards such as :not([href*="?"]). It introduces no CSS
// execution capability; forbidden tokens and pseudo-class restrictions still apply above.
const SELECTOR_CHAR_RE = /^[\w\s.#[\]="':,>+~*()^$|@/?-]+$/;
// note: '@' is allowed as a char only so the forbidden "@import" check (run first) is what gates it;
// a bare '@' never forms a valid simple selector and is harmless if it slips through char-validation.

/**
 * Safe-CSS allowlist (KTD13): element/class/id/attribute/combinator selectors plus
 * `:not()`/`:is()`/`:has()`/`:where()` only. Rejects `url()`, `@import`, `:visited`-style side
 * channels, pseudo-elements, and rule-block punctuation.
 */
export function isSafeSelector(selector: string): boolean {
  if (typeof selector !== "string") return false;
  const s = selector.trim();
  if (s.length === 0 || s.length > MAX_SELECTOR_LEN) return false;

  const lower = s.toLowerCase();
  for (const token of FORBIDDEN_SELECTOR_TOKENS) {
    if (lower.includes(token)) return false;
  }
  // Every pseudo-class (":name") must be in the allowlist.
  for (const match of s.matchAll(/:([a-z-]+)/gi)) {
    if (!ALLOWED_PSEUDOS.has(match[1]!.toLowerCase())) return false;
  }
  return SELECTOR_CHAR_RE.test(s);
}

export type ValidationResultV2 =
  | { readonly ok: true; readonly value: SignedRuleSetV2 }
  | { readonly ok: false; readonly errors: readonly string[] };

const TOP_KEYS_V2 = new Set(["format", "version", "services", "signature"]);
const HIDE_KEYS_V2 = new Set(["id", "feature", "action", "selectors"]);
const BLOCK_KEYS_V2 = new Set(["id", "feature", "action"]);

/** Bound numeric components so the existing component-wise comparator stays exact. */
export function isRuleVersionV2(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && VERSION_RE.test(value)
    && value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

/** JSON data only, bounded before serialization; no getters, prototypes or executable hooks. */
function isBoundedRuleData(value: unknown, depth = 0, budget = { remaining: 8192 }): boolean {
  if (--budget.remaining < 0 || depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 512;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(descriptors).length) return false;
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (value.length > 8192 || keys.length !== value.length
      || !keys.every((key, index) => key === String(index))) return false;
  }
  return Object.entries(descriptors).every(([key, property]) => {
    if (Array.isArray(value) && key === "length") return true;
    return property.enumerable && "value" in property && isBoundedRuleData(property.value, depth + 1, budget);
  });
}

function isServiceMatchV2(value: unknown, service: string): boolean {
  if (typeof value !== "string" || value.length > MAX_PATTERN_LEN) return false;
  // No downloaded path/regex/capture contract yet. Existing host permissions remain the limit.
  const match = /^(?:\*|https?):\/\/(\*\.)?([a-z0-9.-]+)\/\*$/.exec(value);
  if (!match) return false;
  const host = match[2]!;
  const domain = `${service}.com`;
  return /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host)
    && (host === domain || (!match[1] && host.endsWith(`.${domain}`)));
}

/** Opt-in format-2 admission. Format-1 consumers deliberately continue using validateRuleSet. */
export function validateRuleSetV2(input: unknown): ValidationResultV2 {
  const fail = (message: string): ValidationResultV2 => ({ ok: false, errors: [message] });
  if (!isBoundedRuleData(input)) return fail("format 2 requires bounded plain JSON data");
  if (!isObject(input) || !hasOnlyKeys(input, TOP_KEYS_V2) || input.format !== 2) return fail("unsupported rule format or keys");
  if (!isRuleVersionV2(input.version)) return fail("invalid format 2 version");
  const sig = input.signature;
  if (!isObject(sig) || !hasOnlyKeys(sig, SIGNATURE_KEYS)
    || typeof sig.kid !== "string" || sig.kid.length === 0 || sig.kid.length > 64
    || sig.alg !== "ed25519" || typeof sig.value !== "string" || !/^[0-9a-f]{128}$/.test(sig.value)) {
    return fail("invalid format 2 signature envelope");
  }
  if (!isObject(input.services) || Object.keys(input.services).length === 0) return fail("services must be non-empty");
  const ids = new Set<string>();
  for (const [serviceId, service] of Object.entries(input.services)) {
    if (!SERVICE_IDS.includes(serviceId as (typeof SERVICE_IDS)[number]) || !isObject(service)
      || !hasOnlyKeys(service, SERVICE_KEYS)) return fail("unknown or malformed service");
    if (!Array.isArray(service.matches) || service.matches.length === 0 || service.matches.length > 16
      || !service.matches.every((match) => isServiceMatchV2(match, serviceId))) return fail("invalid service host patterns");
    if (!Array.isArray(service.surfaces) || service.surfaces.length === 0 || service.surfaces.length > 64) return fail("invalid surfaces bound");
    for (const surface of service.surfaces) {
      if (!isObject(surface) || typeof surface.id !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(surface.id)
        || ids.has(surface.id)) return fail("invalid or duplicate surface id");
      ids.add(surface.id);
      if (serviceId === TIKTOK_ALIAS.service) {
        if (!hasOnlyKeys(surface, BLOCK_KEYS_V2) || surface.feature !== TIKTOK_ALIAS.id
          || surface.action !== "blockSite") return fail("TikTok requires its packaged service alias and blockSite");
      } else {
        if (!hasOnlyKeys(surface, HIDE_KEYS_V2) || surface.action !== "hide"
          || !FEATURE_REGISTRY.some((feature) => feature.id === surface.feature && feature.service === serviceId)) {
          return fail("unknown action or feature/service ownership");
        }
        if (!Array.isArray(surface.selectors) || surface.selectors.length === 0 || surface.selectors.length > 32
          || !surface.selectors.every((selector) => typeof selector === "string" && isSafeSelector(selector))) {
          return fail("invalid or unsafe selectors");
        }
      }
    }
  }
  const serialized = JSON.stringify(input);
  if (new TextEncoder().encode(serialized).length > 256 * 1024) return fail("format 2 payload exceeds byte bound");
  // Snapshot admission so signing's async operation cannot return later-mutated unsigned data.
  return { ok: true, value: JSON.parse(serialized) as SignedRuleSetV2 };
}

function isSafePattern(pattern: unknown): pattern is string {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_PATTERN_LEN) {
    return false;
  }
  try {
    // Compile-check; the engine matches against location.pathname (a short, bounded string).
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function isSafeRedirectTarget(to: unknown): to is string {
  if (typeof to !== "string" || to.length === 0 || to.length > MAX_PATTERN_LEN) return false;
  // Same-origin relative path only. No protocol, no protocol-relative, no javascript:.
  if (!to.startsWith("/") || to.startsWith("//")) return false;
  const lower = to.toLowerCase();
  return !lower.includes("javascript:") && !lower.includes("http:") && !lower.includes("https:");
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(obj).every((k) => allowed.has(k));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function validateRuleSet(input: unknown): ValidationResult {
  const errors: string[] = [];
  const fail = (msg: string): ValidationResult => ({ ok: false, errors: [...errors, msg] });

  if (!isObject(input)) return fail("rule set must be an object");
  if (!hasOnlyKeys(input, TOP_KEYS)) errors.push("rule set has unexpected top-level keys");

  if (typeof input.version !== "string" || !VERSION_RE.test(input.version)) {
    return fail("version must be a dotted-numeric string");
  }

  // signature envelope (shape only; verification is separate)
  const sig = input.signature;
  if (!isObject(sig) || !hasOnlyKeys(sig, SIGNATURE_KEYS)) return fail("signature envelope malformed");
  if (typeof sig.kid !== "string" || sig.kid.length === 0) return fail("signature.kid missing");
  if (sig.alg !== "ed25519") return fail("signature.alg must be 'ed25519'");
  if (typeof sig.value !== "string" || !/^[0-9a-f]+$/i.test(sig.value)) return fail("signature.value must be hex");

  if (!isObject(input.services)) return fail("services must be an object");
  const serviceIds = Object.keys(input.services);
  if (serviceIds.length === 0) return fail("services is empty");

  for (const serviceId of serviceIds) {
    const service = input.services[serviceId];
    if (!isObject(service) || !hasOnlyKeys(service, SERVICE_KEYS)) {
      errors.push(`service '${serviceId}' malformed`);
      continue;
    }
    if (!Array.isArray(service.matches) || service.matches.length === 0 || !service.matches.every((m) => typeof m === "string")) {
      errors.push(`service '${serviceId}' must have a non-empty string matches[]`);
    }
    if (!Array.isArray(service.surfaces) || service.surfaces.length === 0) {
      errors.push(`service '${serviceId}' must have at least one surface`);
      continue;
    }
    for (const surface of service.surfaces) {
      validateSurface(serviceId, surface, errors);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as SignedRuleSet };
}

function validateSurface(serviceId: string, surface: unknown, errors: string[]): void {
  const where = `service '${serviceId}' surface`;
  if (!isObject(surface) || !hasOnlyKeys(surface, SURFACE_KEYS)) {
    errors.push(`${where} malformed or has unexpected keys`);
    return;
  }
  const id = surface.id;
  const label = surface.label;
  const action = surface.action;
  if (typeof id !== "string" || id.length === 0) errors.push(`${where} missing id`);
  if (typeof label !== "string" || label.length === 0) errors.push(`surface '${String(id)}' missing label`);
  if (surface.tier !== undefined && !SURFACE_TIERS.includes(surface.tier as SurfaceTier)) {
    errors.push(`surface '${String(id)}' has unknown tier '${String(surface.tier)}'`);
  }
  if (
    surface.requiredCapability !== undefined &&
    !SURFACE_CAPABILITIES.includes(surface.requiredCapability as SurfaceCapability)
  ) {
    errors.push(`surface '${String(id)}' has unknown requiredCapability '${String(surface.requiredCapability)}'`);
  }
  if (typeof surface.enabledByDefault !== "boolean") errors.push(`surface '${String(id)}' enabledByDefault must be boolean`);
  if (typeof action !== "string" || !RULE_ACTIONS.includes(action as RuleAction)) {
    errors.push(`surface '${String(id)}' has unknown action '${String(action)}'`);
    return;
  }

  const hasSelectors = surface.selectors !== undefined;
  const hasRedirect = surface.redirect !== undefined;
  const hasUrlMatch = surface.urlMatch !== undefined;

  switch (action as RuleAction) {
    case "hide":
    case "remove": {
      if (hasRedirect || hasUrlMatch) errors.push(`surface '${String(id)}' (${action}) must not carry redirect/urlMatch`);
      if (!Array.isArray(surface.selectors) || surface.selectors.length === 0) {
        errors.push(`surface '${String(id)}' (${action}) needs a non-empty selectors[]`);
      } else if (!surface.selectors.every((s) => typeof s === "string" && isSafeSelector(s))) {
        errors.push(`surface '${String(id)}' has an unsafe or non-string selector`);
      }
      break;
    }
    case "redirect": {
      if (hasSelectors || hasUrlMatch) errors.push(`surface '${String(id)}' (redirect) must not carry selectors/urlMatch`);
      const r = surface.redirect;
      if (!isObject(r) || !hasOnlyKeys(r, REDIRECT_KEYS)) {
        errors.push(`surface '${String(id)}' redirect malformed`);
      } else {
        if (!isSafePattern(r.urlMatch)) errors.push(`surface '${String(id)}' redirect.urlMatch invalid`);
        if (!isSafeRedirectTarget(r.to)) errors.push(`surface '${String(id)}' redirect.to must be a same-origin path`);
        if (r.fallbackToPlaceholder !== undefined && typeof r.fallbackToPlaceholder !== "boolean") {
          errors.push(`surface '${String(id)}' redirect.fallbackToPlaceholder must be boolean`);
        }
      }
      break;
    }
    case "placeholder": {
      if (hasSelectors || hasRedirect) errors.push(`surface '${String(id)}' (placeholder) must not carry selectors/redirect`);
      if (!isSafePattern(surface.urlMatch)) errors.push(`surface '${String(id)}' placeholder needs a valid urlMatch`);
      break;
    }
    case "blockSite": {
      if (hasSelectors || hasRedirect || hasUrlMatch) {
        errors.push(`surface '${String(id)}' (blockSite) must not carry selectors/redirect/urlMatch`);
      }
      break;
    }
  }
}
