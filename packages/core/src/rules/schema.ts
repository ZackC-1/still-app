import {
  RULE_ACTIONS,
  type RuleAction,
  type SignedRuleSet,
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

const SURFACE_KEYS = new Set(["id", "label", "action", "enabledByDefault", "selectors", "redirect", "urlMatch"]);
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
const SELECTOR_CHAR_RE = /^[\w\s.#[\]="':,>+~*()^$|@/-]+$/;
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
