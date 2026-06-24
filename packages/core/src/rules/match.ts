import type { ServiceId, SignedRuleSet } from "@still/shared-types";

// URL / match-pattern helpers. Pure functions over a WHATWG URL, jsdom- and worker-safe.

/** Tests a URL against a single MV3 match pattern (`<scheme>://<host>/<path>`). */
export function urlMatchesPattern(url: URL, pattern: string): boolean {
  const m = /^(\*|https?|file|ftp):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const scheme = m[1]!;
  const hostPat = m[2]!;
  const pathPat = m[3]!;

  const proto = url.protocol.replace(":", "");
  if (scheme === "*") {
    if (proto !== "http" && proto !== "https") return false;
  } else if (scheme !== proto) {
    return false;
  }
  if (!hostMatches(url.hostname, hostPat)) return false;
  return pathMatches(url.pathname, pathPat);
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return host === base || host.endsWith("." + base);
  }
  return host === pattern;
}

function pathMatches(path: string, pattern: string): boolean {
  // MV3 path matching: only `*` is a wildcard (matches any run, including `/`).
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$").test(path);
}

/** The first service in the rule set whose any match pattern matches this URL, else null. */
export function resolveService(ruleSet: SignedRuleSet, url: URL): ServiceId | null {
  for (const [serviceId, service] of Object.entries(ruleSet.services)) {
    if (service && service.matches.some((p) => urlMatchesPattern(url, p))) {
      return serviceId as ServiceId;
    }
  }
  return null;
}

/**
 * eTLD+1 for a hostname, used as the per-site pause key. v1 services are all `.com`, so the
 * last-two-labels heuristic is exact for them (youtube.com, m.youtube.com → "youtube.com").
 * Multi-part public suffixes (e.g. co.uk) are out of scope for the four launch domains.
 */
export function etldPlusOne(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;
  return labels.slice(-2).join(".");
}

/** Substitute `$1`..`$9` in a redirect target template with the regex match's capture groups. */
export function applyRedirectTemplate(template: string, match: RegExpExecArray): string {
  return template.replace(/\$([1-9])/g, (_whole, d: string) => match[Number(d)] ?? "");
}
