import type { AccessTrust } from "./access-proof.js";

/** Build-time public material only. Never pass request, remote response or persisted cache data. */
export function packagedAccessTrust(
  config: { readonly environment?: string; readonly publicKeys?: string } = {},
): AccessTrust {
  const environment =
    config.environment === "sandbox" ? "sandbox" : "production";
  const empty = (): AccessTrust =>
    Object.freeze({ environment, keys: Object.freeze([]) });
  if (
    config.environment !== undefined &&
    config.environment !== "production" &&
    config.environment !== "sandbox"
  )
    return empty();
  if (!config.publicKeys || config.publicKeys.length > 16_384) return empty();
  try {
    const raw: unknown = JSON.parse(config.publicKeys);
    if (!Array.isArray(raw) || raw.length > 8) return empty();
    const seen = new Set<string>();
    const keys: AccessTrust["keys"][number][] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return empty();
      const key = item as Record<string, unknown>;
      if (
        Object.keys(key).sort().join(",") !==
          "environment,kid,publicKeyHex,purpose" ||
        typeof key.kid !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(key.kid) ||
        typeof key.publicKeyHex !== "string" ||
        !/^[0-9a-f]{64}$/.test(key.publicKeyHex) ||
        key.purpose !== "access" ||
        key.environment !== environment ||
        seen.has(key.kid)
      )
        return empty();
      seen.add(key.kid);
      keys.push(
        Object.freeze({
          kid: key.kid,
          publicKeyHex: key.publicKeyHex,
          purpose: "access",
          environment,
        }),
      );
    }
    return Object.freeze({ environment, keys: Object.freeze(keys) });
  } catch {
    return empty();
  }
}
