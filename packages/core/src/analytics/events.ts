import { SERVICE_IDS } from "@still/shared-types";

// The complete list of product-analytics events Still may send, and the only properties each one
// may carry. Nothing outside this file can widen it: the client validates every event against the
// schema below before it is queued, and drops anything that does not match.
//
// The boundary this protects is the product promise that Still never records browsing history.
// Every property value is a boolean, one of a fixed set of words, or a version number. There is no
// free-text field anywhere, so no web address, page title, video id or search term can ride along,
// whoever calls `track`. Extending the schema means adding another fixed word or boolean, never a
// string a caller chooses.

/** Where this copy of Still is running. The Safari extension and its host app are separate
 * surfaces on the same device: people can use one without opening the other. */
export const ANALYTICS_SURFACES = [
  "chrome",
  "firefox",
  "safari-ios",
  "safari-macos",
  "app-ios",
  "app-macos",
] as const;
export type AnalyticsSurface = (typeof ANALYTICS_SURFACES)[number];

/** Which store this copy was downloaded from. The iPhone app and its Safari extension share one
 * download, as do the Mac app and its extension. */
export type AnalyticsStore = "ios" | "macos" | "chrome" | "firefox";

export function storeForSurface(surface: AnalyticsSurface): AnalyticsStore {
  switch (surface) {
    case "chrome":
      return "chrome";
    case "firefox":
      return "firefox";
    case "safari-ios":
    case "app-ios":
      return "ios";
    case "safari-macos":
    case "app-macos":
      return "macos";
  }
}

/** Why an emailed code did not sign someone in. `network` covers every transport failure. */
export const CODE_FAILURE_REASONS = ["wrong", "expired", "rate_limited", "network"] as const;

/** Where in the sheet someone gave up: before a code was sent, or while holding one. */
export const SIGN_IN_STAGES = ["email", "code"] as const;

/** Which Still screen was opened. */
export const OPENED_WHERE = ["popup", "options", "app"] as const;

/** Setup milestones a host can observe. `extension_enabled` is reported by the Mac app when Safari
 * says Still is on, and by the Safari extension itself the first time it runs (the only signal an
 * iPhone has). */
export const SETUP_STEPS = ["app_opened", "extension_enabled"] as const;

type Spec = "boolean" | "version" | readonly string[];

/** The schema. Keys are event names; each value lists the properties that event may carry. */
export const EVENT_SCHEMA = {
  // Install and lifecycle.
  installed: { returning: "boolean" },
  updated: { from: "version", to: "version" },
  opened: { where: OPENED_WHERE },
  active: {},
  // Activation.
  setup_step: { step: SETUP_STEPS },
  setup_completed: {},
  global_toggled: { enabled: "boolean" },
  service_toggled: { service: SERVICE_IDS, enabled: "boolean" },
  // Deliberately absent: any event from a content script, or naming a service someone visited.
  // Owner decision 2026-09-23 (ADR 0004): that would be browsing history, which Still never collects.
  // Sign-in funnel.
  sign_in_opened: {},
  code_requested: {},
  code_failed: { reason: CODE_FAILURE_REASONS },
  sign_in_abandoned: { stage: SIGN_IN_STAGES },
  // account_created is sent by the server (analytics-identify), once per account, never by a client.
  signed_in: {},
  signed_out: {},
  account_deleted: {},
} as const satisfies Record<string, Record<string, Spec>>;

export type AnalyticsEventName = keyof typeof EVENT_SCHEMA;

type ValueOf<S> = S extends "boolean"
  ? boolean
  : S extends "version"
    ? string
    : S extends readonly (infer W)[]
      ? W
      : never;

export type AnalyticsEventProps<E extends AnalyticsEventName> = {
  readonly [K in keyof (typeof EVENT_SCHEMA)[E]]: ValueOf<(typeof EVENT_SCHEMA)[E][K]>;
};

/** A version number such as `2.1.0` or `2.1.0.1`, and nothing else. */
const VERSION = /^\d{1,5}(\.\d{1,5}){0,3}$/;

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value);
}

/**
 * Check an event against the schema. Returns the event's properties, copied, when every expected
 * property is present with an allowed value and nothing else is attached; otherwise null.
 * Runtime-checked on purpose: popup and content-script messages arrive untyped.
 */
export function validateEvent(
  name: unknown,
  props: unknown,
): Record<string, boolean | string> | null {
  if (typeof name !== "string" || !Object.hasOwn(EVENT_SCHEMA, name)) return null;
  const spec = EVENT_SCHEMA[name as AnalyticsEventName] as Record<string, Spec>;
  const given = props ?? {};
  if (typeof given !== "object" || Array.isArray(given)) return null;
  const entries = Object.entries(given as Record<string, unknown>);
  if (entries.length !== Object.keys(spec).length) return null;
  const out: Record<string, boolean | string> = {};
  for (const [key, value] of entries) {
    if (!Object.hasOwn(spec, key)) return null;
    const expected = spec[key]!;
    if (expected === "boolean") {
      if (typeof value !== "boolean") return null;
    } else if (expected === "version") {
      if (!isVersion(value)) return null;
    } else if (typeof value !== "string" || !expected.includes(value)) {
      return null;
    }
    out[key] = value as boolean | string;
  }
  return out;
}
