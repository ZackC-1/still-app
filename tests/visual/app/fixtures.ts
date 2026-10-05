// Fixture builders shared by the case files. They speak the design package's control ids
// (yt_comments, ig_stories, sidebar_ads, ...) so each case reads like its reference frame's props,
// and translate them to the repository's registry ids. Nothing here is product state.
import {
  DEFAULT_SETTINGS,
  FEATURE_REGISTRY,
  type AccessState,
  type BenefitAccessSnapshot,
  type FeatureId,
  type ServiceId,
  type SettingsV2,
} from "@still/shared-types";

export const DESIGN_IDS = {
  yt_shorts: "youtube.shorts",
  yt_related: "youtube.related",
  yt_endscreen: "youtube.endscreen",
  yt_autoplay: "youtube.autoplay",
  yt_comments: "youtube.comments",
  yt_livechat: "youtube.livechat",
  ig_reels: "instagram.reels",
  ig_explore: "instagram.explore",
  ig_stories: "instagram.stories",
  ig_suggested: "instagram.suggested",
  ig_threads: "instagram.threads",
  fb_reels: "facebook.reels",
  fb_stories: "facebook.stories",
  fb_videos: "facebook.videos",
  sidebar_ads: "facebook.sponsored",
} as const satisfies Record<string, FeatureId>;
export type DesignId = keyof typeof DESIGN_IDS;

/** The design's access words mapped to the repository's AccessState. */
export type DesignAccess =
  | "locked"
  | "purchased"
  | "protected"
  | "checking"
  | "verify"
  | "unsupported"
  | "free";
const ACCESS_WORD: Record<DesignAccess, AccessState> = {
  locked: "locked",
  purchased: "purchased",
  protected: "protected",
  checking: "checking",
  verify: "verification_required",
  unsupported: "unsupported",
  free: "free",
};

export const PRO_IDS = FEATURE_REGISTRY.filter((row) => row.tier === "pro").map(
  (row) => row.id,
);

/** Every Pro control in one state, free controls free (review.babel `accessAll`). */
export function accessAll(
  state: DesignAccess,
  overrides: Partial<Record<DesignId, DesignAccess>> = {},
): BenefitAccessSnapshot {
  const states = Object.fromEntries([
    ...FEATURE_REGISTRY.map((row) => [
      row.id,
      row.tier === "pro" ? ACCESS_WORD[state] : "free",
    ]),
    ["tiktok.all", "free"],
  ]) as Record<string, AccessState>;
  for (const [id, value] of Object.entries(overrides) as [
    DesignId,
    DesignAccess,
  ][])
    states[DESIGN_IDS[id]] = ACCESS_WORD[value];
  return {
    schema: 1,
    generation: 1,
    states: states as BenefitAccessSnapshot["states"],
    refreshAfterMs: null,
    independentProtection: [],
  };
}

/**
 * Saved settings for a frame. Free controls and every service start On, Pro controls Off
 * (fresh defaults), then the frame's `values` and `on` apply.
 */
export function settingsFor(
  options: {
    on?: boolean;
    values?: Partial<Record<DesignId | ServiceId, boolean>>;
  } = {},
): SettingsV2 {
  const services: Record<ServiceId, boolean> = { ...DEFAULT_SETTINGS.services };
  const sites = Object.fromEntries(
    FEATURE_REGISTRY.map((row) => [row.id, row.freshDefault]),
  ) as Record<FeatureId, boolean>;
  for (const [id, value] of Object.entries(options.values ?? {})) {
    if (id in services) services[id as ServiceId] = Boolean(value);
    else sites[DESIGN_IDS[id as DesignId]] = Boolean(value);
  }
  return {
    schemaVersion: 2,
    globalOn: options.on ?? true,
    services,
    sites,
    clocks: {},
    updatedAt: 0,
  } as unknown as SettingsV2;
}

export const noop = () => {};

/** Map design-id keyed labels (German frames) to registry-id keyed labels. */
export function labelsFor(
  rows: { id: DesignId; label: string }[],
): Partial<Record<FeatureId, string>> {
  return Object.fromEntries(rows.map((row) => [DESIGN_IDS[row.id], row.label]));
}
