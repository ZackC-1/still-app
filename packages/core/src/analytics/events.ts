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
  "firefox-android",
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
    case "firefox-android":
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

/** Which Still screen was opened, or where a switch was flipped: the extension's small toolbar popup,
 * its full settings page, or the Apple app's own screen. */
export const OPENED_WHERE = ["popup", "options", "app"] as const;
export type AnalyticsWhere = (typeof OPENED_WHERE)[number];

/** The kind of device, carried on every event: the Safari extension on an iPhone, an iPad and a Mac
 * are three different things to support, and the store alone (ios / macos) cannot tell a phone
 * from a tablet. */
export const DEVICE_CLASSES = ["phone", "tablet", "desktop"] as const;
export type AnalyticsDevice = (typeof DEVICE_CLASSES)[number];

export function isDeviceClass(value: unknown): value is AnalyticsDevice {
  return typeof value === "string" && (DEVICE_CLASSES as readonly string[]).includes(value);
}

/** Setup milestones a host can observe. `extension_enabled` is reported by the Mac app when Safari
 * says Still is on, and by the Safari extension itself the first time it runs (the only signal an
 * iPhone has). */
export const SETUP_STEPS = ["app_opened", "extension_enabled"] as const;

type Spec = "boolean" | "version" | readonly string[];

/** The single closed catalogue. Producer authority is checked separately from property grammar. */
export const EVENT_SCHEMA = {
  installed: {
    returning: "boolean",
  },
  updated: {
    from: "version",
    to: "version",
  },
  opened: {
    where: ["popup", "options", "app"],
  },
  active: {},
  setup_step: {
    step: ["app_opened", "extension_enabled"],
  },
  setup_completed: {},
  sign_in_opened: {},
  code_requested: {},
  code_failed: {
    reason: ["wrong", "expired", "rate_limited", "network"],
  },
  sign_in_abandoned: {
    stage: ["email", "code"],
  },
  signed_in: {},
  signed_out: {},
  account_created: {},
  analytics_choice_made: {
    choice: ["share"],
  },
  global_toggled: {
    enabled: "boolean",
    where: ["popup", "options", "app"],
  },
  master_toggled: {
    site: ["youtube", "instagram", "facebook", "tiktok"],
    enabled: "boolean",
    where: ["popup", "options", "app"],
    cause: ["direct"],
  },
  switch_toggled: {
    site: ["youtube", "instagram", "facebook"],
    switch: [
      "youtube.shorts",
      "youtube.related",
      "youtube.endscreen",
      "youtube.autoplay",
      "youtube.comments",
      "youtube.livechat",
      "instagram.reels",
      "instagram.explore",
      "instagram.stories",
      "instagram.suggested",
      "instagram.threads",
      "facebook.reels",
      "facebook.stories",
      "facebook.videos",
      "facebook.sponsored",
    ],
    enabled: "boolean",
    where: ["popup", "options", "app"],
  },
  locked_switch_tapped: {
    site: ["youtube", "instagram", "facebook"],
    switch: [
      "youtube.shorts",
      "youtube.related",
      "youtube.endscreen",
      "youtube.autoplay",
      "youtube.comments",
      "youtube.livechat",
      "instagram.reels",
      "instagram.explore",
      "instagram.stories",
      "instagram.suggested",
      "instagram.threads",
      "facebook.reels",
      "facebook.stories",
      "facebook.videos",
      "facebook.sponsored",
    ],
    where: ["popup", "options", "app"],
  },
  paywall_viewed: {
    trigger: ["locked_switch", "upgrade_button"],
    where: ["popup", "options", "app"],
  },
  paywall_dismissed: {
    trigger: ["locked_switch", "upgrade_button"],
    where: ["popup", "options", "app"],
  },
  purchase_started: {
    purchase_origin: ["app_store", "mac_app_store", "web", "account", "unknown"],
    product: ["still-pro-v3"],
  },
  purchase_completed: {
    purchase_origin: ["app_store", "mac_app_store", "web", "account", "unknown"],
    product: ["still-pro-v3"],
  },
  purchase_cancelled: {
    purchase_origin: ["app_store", "mac_app_store", "web", "account", "unknown"],
    product: ["still-pro-v3"],
  },
  purchase_pending: {
    purchase_origin: ["app_store", "mac_app_store", "web", "account", "unknown"],
    product: ["still-pro-v3"],
  },
  purchase_failed: {
    purchase_origin: ["app_store", "mac_app_store", "web", "account", "unknown"],
    product: ["still-pro-v3"],
    reason: ["network", "store_error", "not_allowed", "unknown"],
  },
  checkout_returned: {
    outcome: ["success", "cancelled", "pending", "unknown"],
  },
  restore_started: {
    purchase_origin: ["app_store", "mac_app_store", "web", "account", "unknown"],
  },
  restore_completed: {
    purchase_origin: ["app_store", "mac_app_store", "web", "account", "unknown"],
    outcome: ["restored", "nothing_to_restore", "failed", "pending"],
  },
  purchase_recorded: {
    purchase_origin: ["app_store", "mac_app_store", "web"],
    product: ["still-pro-v3"],
  },
  purchase_refunded: {
    purchase_origin: ["app_store", "mac_app_store", "web"],
    product: ["still-pro-v3"],
  },
  sync_completed: {
    trigger: ["first_sign_in", "settings_change", "resume", "retry"],
  },
  sync_failed: {
    reason: ["network", "auth", "server", "unknown"],
  },
  onboarding_step_viewed: {
    flow: ["apple_app"],
    step: [
      "welcome",
      "how_it_works",
      "enable_extension",
      "site_access",
      "choose_switches",
      "sync_offer",
      "analytics_notice",
      "done",
    ],
  },
  onboarding_completed: {
    flow: ["apple_app"],
    skipped: "boolean",
  },
  safari_extension_setup_step: {
    step: ["instructions_viewed", "open_settings_tapped", "returned_to_app", "help_viewed"],
  },
  extension_enabled: {
    detected_by: ["app_check"],
  },
  extension_disabled: {
    detected_by: ["app_check"],
  },
  sync_prompt_viewed: {
    trigger: ["settings_milestone", "post_purchase"],
    where: ["popup", "options", "app"],
  },
  sync_prompt_response: {
    trigger: ["settings_milestone", "post_purchase"],
    response: ["sign_in", "not_now", "dismissed"],
  },
  sign_in_started: {
    source: ["sync_prompt", "post_purchase"],
  },
  website_page_viewed: {
    page: ["home", "download", "privacy", "help"],
  },
  store_link_clicked: {
    store: ["ios", "macos", "chrome", "firefox"],
  },
} as const satisfies Record<string, Record<string, Spec>>;

export type CanonicalAnalyticsEventName = keyof typeof EVENT_SCHEMA;
/** Input compatibility only; these names never widen the outbound catalogue. */
export type AnalyticsEventName = CanonicalAnalyticsEventName | "service_toggled" | "account_deleted";
type ValueOf<S> = S extends "boolean"
  ? boolean
  : S extends "version"
    ? string
    : S extends readonly (infer W)[]
      ? W
      : never;
export type AnalyticsEventProps<E extends AnalyticsEventName> = E extends "service_toggled"
  ? {
      readonly service: (typeof SERVICE_IDS)[number];
      readonly enabled: boolean;
      readonly where: AnalyticsWhere;
    }
  : E extends "account_deleted"
    ? Record<string, never>
    : E extends "paywall_viewed" | "paywall_dismissed"
      ? { readonly where: AnalyticsWhere } & (
          | { readonly trigger: "upgrade_button" }
          | {
              readonly trigger: "locked_switch";
              readonly site: ValueOf<typeof EVENT_SCHEMA.locked_switch_tapped.site>;
              readonly switch: ValueOf<typeof EVENT_SCHEMA.locked_switch_tapped.switch>;
            }
        )
      : E extends CanonicalAnalyticsEventName
        ? {
            readonly [K in keyof (typeof EVENT_SCHEMA)[E]]: ValueOf<(typeof EVENT_SCHEMA)[E][K]>;
          }
        : never;
const VERSION = /^\d{1,5}(\.\d{1,5}){0,3}$/;
export function isVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value);
}
export const ANALYTICS_OS = ["macos", "windows", "linux", "chromeos", "ios", "android", "other"] as const;
export const ANALYTICS_BUILD_CHANNELS = ["release", "dev", "test"] as const;

/** The envelope a host passes for its build. Only the QA profiles (scripts/qa/v3-profile.mjs) set
 * VITE_ANALYTICS_BUILD_CHANNEL, to "test"; anything else leaves events unlabelled, exactly as store
 * builds send them. `build_channel` is an existing closed envelope field, not new collected data. */
export function buildChannelEnvelope(value: unknown): { readonly build_channel: "test" } | undefined {
  return value === "test" ? { build_channel: "test" } : undefined;
}
export const ANALYTICS_PLANS = ["free", "pro", "grandfathered"] as const;

/** Server canonical sales/account creation and independently consented website events cannot
 * borrow app permission or identity. Their actual producers remain separate integration gates. */
export function isAppClientEvent(name: string): boolean {
  return (
    Object.hasOwn(EVENT_SCHEMA, name) &&
    ![
      "account_created",
      "purchase_recorded",
      "purchase_refunded",
      "website_page_viewed",
      "store_link_clicked",
    ].includes(name)
  );
}

export function validateEvent(name: unknown, props: unknown): Record<string, boolean | string> | null {
  if (typeof name !== "string" || !Object.hasOwn(EVENT_SCHEMA, name)) return null;
  const given = props ?? {};
  if (typeof given !== "object" || Array.isArray(given) || given === null) return null;
  const spec: Record<string, Spec> = {
    ...EVENT_SCHEMA[name as CanonicalAnalyticsEventName],
  };
  const input = given as Record<string, unknown>;
  if ((name === "paywall_viewed" || name === "paywall_dismissed") && input.trigger === "locked_switch") {
    spec.site = EVENT_SCHEMA.locked_switch_tapped.site;
    spec.switch = EVENT_SCHEMA.locked_switch_tapped.switch;
  }
  const entries = Object.entries(input);
  if (entries.length !== Object.keys(spec).length) return null;
  const out: Record<string, boolean | string> = {};
  for (const [key, value] of entries) {
    if (!Object.hasOwn(spec, key)) return null;
    const expected = spec[key]!;
    if (expected === "boolean") {
      if (typeof value !== "boolean") return null;
    } else if (expected === "version") {
      if (!isVersion(value)) return null;
    } else if (typeof value !== "string" || !expected.includes(value)) return null;
    out[key] = value as boolean | string;
  }
  if (typeof out.switch === "string" && out.switch.split(".")[0] !== out.site) return null;
  return out;
}

/** Rename the old committed master-control input at the one common admission boundary.
 * Never dual emit, and never interpret a visited site/content-script message as this action. */
export function canonicalEvent(
  name: unknown,
  props: unknown,
): {
  name: CanonicalAnalyticsEventName;
  props: Record<string, boolean | string>;
} | null {
  if (name === "service_toggled") {
    if (!props || typeof props !== "object" || Array.isArray(props)) return null;
    const value = props as Record<string, unknown>;
    if (
      Object.keys(value).length !== 3 ||
      !Object.hasOwn(value, "service") ||
      !Object.hasOwn(value, "enabled") ||
      !Object.hasOwn(value, "where")
    )
      return null;
    props = {
      site: value.service,
      enabled: value.enabled,
      where: value.where,
      cause: "direct",
    };
    name = "master_toggled";
  }
  const validated = validateEvent(name, props);
  return validated ? { name: name as CanonicalAnalyticsEventName, props: validated } : null;
}
