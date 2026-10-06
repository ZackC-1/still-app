import { describe, expect, it } from "vitest";
import {
  firefoxAndroidSettings,
  firefoxBrowserSpecificSettings,
  runsV3Interface,
  stillManifest,
  type ManifestBuildEnv,
} from "../../wxt.config";
import { modernSettingsRuntime } from "../modern-settings-runtime";
import { tiktokBlockedPageEnabled } from "../../entrypoints/tiktok-blocked/gate";

// Build inputs, named explicitly so these tests never depend on the shell running them.
const UNCONFIGURED: ManifestBuildEnv = {};
const CONFIGURED_2X: ManifestBuildEnv = {
  VITE_SUPABASE_URL: "https://still-audit.invalid",
  VITE_SUPABASE_ANON_KEY: "public-audit-placeholder",
};
const CONFIGURED_V3: ManifestBuildEnv = { ...CONFIGURED_2X, VITE_MODERN_SETTINGS_SYNC_ENABLED: "true" };

const FOUR_HOSTS = [
  "*://*.youtube.com/*",
  "*://*.instagram.com/*",
  "*://*.facebook.com/*",
  "*://*.tiktok.com/*",
];

/** The major version of a Firefox `strict_min_version` such as "142.0". */
function major(version: string): number {
  const match = /^(\d+)\.\d+$/.exec(version);
  if (!match) throw new Error(`Unexpected Firefox version: ${version}`);
  return Number(match[1]);
}

describe("Firefox manifest compatibility", () => {
  it("publishes V3 Firefox builds for desktop Firefox and Firefox for Android", () => {
    const gecko = {
      id: "still@chartash.com",
      strict_min_version: "140.0",
      data_collection_permissions: {
        required: ["authenticationInfo"],
        optional: ["technicalAndInteraction"],
      },
    };
    expect(firefoxBrowserSpecificSettings).toEqual({ gecko });
    for (const env of [UNCONFIGURED, CONFIGURED_V3])
      expect(stillManifest("firefox", env)).toHaveProperty("browser_specific_settings", {
        gecko,
        gecko_android: { strict_min_version: "142.0" },
      });
  });

  it("never lists a configured 2.x build (the pre-V3 interface) for Android", () => {
    expect(stillManifest("firefox", CONFIGURED_2X)).toHaveProperty("browser_specific_settings", firefoxBrowserSpecificSettings);
    expect(JSON.stringify(stillManifest("firefox", CONFIGURED_2X))).not.toContain("gecko_android");
    // A blank or whitespace-only key is unconfigured, exactly as the runtime treats it.
    expect(stillManifest("firefox", { VITE_SUPABASE_URL: " ", VITE_SUPABASE_ANON_KEY: "" })).toHaveProperty(
      "browser_specific_settings.gecko_android",
    );
  });

  it("names Firefox on Android in the summary only for builds listed for Android", () => {
    // The 2.x store summary, byte-for-byte as it shipped before Firefox for Android.
    const shipped2x =
      "Remove YouTube Shorts and Instagram & Facebook Reels, and block the TikTok website. Free, with no timers or stats. Sign in free to sync your settings with Chrome and with Safari on iPhone, iPad and Mac. Desktop Firefox.";
    expect(stillManifest("firefox", CONFIGURED_2X).description).toBe(shipped2x);
    expect(stillManifest("firefox", CONFIGURED_2X).description).not.toContain("Android");
    for (const env of [UNCONFIGURED, CONFIGURED_V3])
      expect(stillManifest("firefox", env).description).toBe(
        "Remove YouTube Shorts and Instagram & Facebook Reels. Block the TikTok website. Free, no timers. Sign in free to sync your settings with Chrome and with Safari on iPhone, iPad and Mac. Works in Safari on iPhone and iPad, and in Firefox on Android.",
      );
  });

  it("decides V3 exactly as the runtime and the TikTok blocked-page gate do", () => {
    for (const env of [
      UNCONFIGURED,
      CONFIGURED_2X,
      CONFIGURED_V3,
      { ...CONFIGURED_2X, VITE_MODERN_SETTINGS_SYNC_ENABLED: "false" },
      { VITE_SUPABASE_URL: "https://still-audit.invalid" },
    ]) {
      const runtime = modernSettingsRuntime(
        env.VITE_SUPABASE_URL,
        env.VITE_SUPABASE_ANON_KEY,
        env.VITE_MODERN_SETTINGS_SYNC_ENABLED,
      ).atomicLocal;
      expect(runsV3Interface(env), JSON.stringify(env)).toBe(runtime);
      expect(tiktokBlockedPageEnabled(env), JSON.stringify(env)).toBe(runtime);
    }
  });

  it("never lets Android install below 142, the first release with the built-in data consent screen", () => {
    // Firefox for Android 141 and older show no data-collection consent at install. Still declares
    // required sign-in data, so a lower floor would let someone sign in without that screen.
    expect(major(firefoxAndroidSettings.strict_min_version)).toBeGreaterThanOrEqual(142);
    // Desktop keeps its own floor (140, the desktop consent screen); Android is never below it.
    expect(major(firefoxBrowserSpecificSettings.gecko.strict_min_version)).toBeGreaterThanOrEqual(140);
  });

  it("adds no permission and no host for Android: the same four sites, storage and alarms only", () => {
    const manifest = stillManifest("firefox", UNCONFIGURED) as Record<string, unknown>;
    expect(manifest.permissions).toEqual(["storage", "alarms"]);
    expect(manifest.host_permissions).toEqual(FOUR_HOSTS);
    expect(manifest).not.toHaveProperty("optional_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest).not.toHaveProperty("declarative_net_request");
    expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
    expect(JSON.stringify(manifest)).not.toContain("declarativeNetRequest");
  });

  it("keeps the Chromium manifest exactly as it was: no Firefox or Android key leaks into it", () => {
    const chrome = stillManifest("chrome", UNCONFIGURED);
    expect(stillManifest("chrome", CONFIGURED_V3)).toEqual(chrome);
    expect(chrome).not.toHaveProperty("browser_specific_settings");
    expect(JSON.stringify(chrome)).not.toContain("gecko");
    expect(chrome).toEqual({
      name: "Still: Remove Shorts & Reels, Stop Scrolling",
      description:
        "Remove YouTube Shorts and Instagram & Facebook Reels. Block the TikTok website. Free, no timers. Syncs with Still on iPhone & Mac.",
      permissions: ["storage", "alarms", "declarativeNetRequestWithHostAccess"],
      host_permissions: FOUR_HOSTS,
      action: { default_title: "Still" },
      declarative_net_request: {
        rule_resources: [
          {
            id: "youtube-shorts-redirect",
            enabled: true,
            path: "rules/dnr-youtube.json",
          },
        ],
      },
    });
  });

  it("keeps usage analytics optional: Firefox refuses it as required, and nothing is sent without it", () => {
    const { required } = firefoxBrowserSpecificSettings.gecko.data_collection_permissions;
    expect(required).not.toContain("technicalAndInteraction");
  });

  it("places a new Firefox install's Still action in the toolbar, without leaking that key to Chromium", () => {
    expect(stillManifest("firefox").action).toEqual({
      default_title: "Still",
      default_area: "navbar",
    });
    expect(stillManifest("chrome").action).toEqual({ default_title: "Still" });
  });

  it("keeps the store name and summary within each store's limits", () => {
    // AMO's validator rejects a name over 45 characters; the Chrome Web Store rejects a description
    // over 132; AMO shows at most 250 characters of summary.
    for (const browser of ["chrome", "firefox"]) expect(stillManifest(browser).name.length).toBeLessThanOrEqual(45);
    expect(stillManifest("chrome").description.length).toBeLessThanOrEqual(132);
    for (const env of [UNCONFIGURED, CONFIGURED_2X, CONFIGURED_V3])
      expect(stillManifest("firefox", env).description.length).toBeLessThanOrEqual(250);
  });
});
