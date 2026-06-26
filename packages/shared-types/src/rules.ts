// Versioned, signed rule-set schema (spec §4.5, KTD13).
//
// A rule set is DATA, never code. The packaged extension is the complete interpreter; a
// runtime-fetched rule set may only supply validated data — service ids, URL match patterns,
// selectors, and action enum values already implemented locally. No JavaScript, expression
// strings, or anything that changes control flow beyond the packaged enum semantics.

/** The finite, packaged set of action semantics. Remote sets may only reference these. */
export const RULE_ACTIONS = ["hide", "remove", "redirect", "placeholder", "blockSite"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];
export const SURFACE_TIERS = ["free", "pro"] as const;
export type SurfaceTier = (typeof SURFACE_TIERS)[number];

/** The four launch services. A brand-new service id defaults OFF until the user enables it. */
export const SERVICE_IDS = ["youtube", "instagram", "tiktok", "facebook"] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

/** `redirect` action: rewrite a short-form URL to its long-form equivalent. */
export interface RedirectRule {
  /** Regex tested against `location.pathname`; capture groups feed `to`. */
  readonly urlMatch: string;
  /** Target template; `$1`..`$9` are replaced by the corresponding capture group. */
  readonly to: string;
  /** When the pattern matches but yields no id (empty capture), show the placeholder instead. */
  readonly fallbackToPlaceholder?: boolean;
}

/**
 * A surface is an internal authoring/QA unit grouped under a service. The user-facing control is
 * one master toggle per service (KTD7); surfaces are not individually toggleable by users.
 */
export interface Surface {
  /** Stable authoring id, e.g. "yt-sidebar". */
  readonly id: string;
  /** Human-readable label for QA / canary reporting. */
  readonly label: string;
  /** Monetization gate. Missing defaults to Pro unless the engine allowlists the surface as free. */
  readonly tier?: SurfaceTier;
  readonly action: RuleAction;
  /**
   * Surface-level default. A rules update that adds a new surface under an already-enabled
   * service applies immediately (`true`); the safety model is per-service, so this is normally
   * `true` for every surface of an existing service (spec §4.5 safety model).
   */
  readonly enabledByDefault: boolean;
  /** `hide` / `remove`: CSS selectors (safe-CSS allowlisted). Desktop + mobile selectors together. */
  readonly selectors?: readonly string[];
  /** `redirect`: the URL rewrite rule. */
  readonly redirect?: RedirectRule;
  /** `placeholder`: regex tested against `location.pathname` that triggers the Still placeholder. */
  readonly urlMatch?: string;
  // `blockSite`: no extra fields — the whole matched domain becomes the placeholder.
}

export interface ServiceRules {
  /** URL match patterns (MV3 match-pattern syntax) covering desktop + mobile hosts. */
  readonly matches: readonly string[];
  readonly surfaces: readonly Surface[];
}

/** The signable content of a rule set (everything except the signature envelope). */
export interface RuleSetPayload {
  /** Dotted numeric version, compared component-wise (e.g. "1.4.0"). Monotonic. */
  readonly version: string;
  readonly services: Readonly<Partial<Record<ServiceId, ServiceRules>>>;
}

/** Ed25519 signature envelope carried alongside the payload. */
export interface RuleSetSignature {
  /** Key id selecting which trusted public key verifies this set (current + next rotation). */
  readonly kid: string;
  readonly alg: "ed25519";
  /** Lowercase-hex Ed25519 signature over the canonical serialization of the payload. */
  readonly value: string;
}

/** A published rule set: payload + signature. */
export interface SignedRuleSet extends RuleSetPayload {
  readonly signature: RuleSetSignature;
}
