import { afterEach, describe, expect, it, vi } from "vitest";
import config, {
  declaresFirefoxAndroid,
  FIREFOX_2X_DESCRIPTION,
  FIREFOX_ANDROID_RELEASE_DEFERRED,
  FIREFOX_V3_DESCRIPTION,
  firefoxAndroidSettings,
  firefoxBrowserSpecificSettings,
  runsV3Interface,
  settingsPageHost,
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
// The V3 store package: scripts/release/package.mjs forwards only these public values.
const RELEASE_V3: ManifestBuildEnv = {
  ...CONFIGURED_V3,
  VITE_POSTHOG_KEY: "phc_publicAuditPlaceholder000000",
  VITE_POSTHOG_HOST: "https://us.i.posthog.com",
};
// The paid-sandbox QA profile (scripts/qa/v3-profile.mjs), which signs the unlisted QA package.
const SANDBOX_QA: ManifestBuildEnv = {
  ...CONFIGURED_V3,
  VITE_PACKAGE_IDENTITY: "paid-sandbox-qa",
  VITE_BACKEND_ROUTE_PROFILE: "shared-hosted-sandbox",
  VITE_ACCESS_ENVIRONMENT: "sandbox",
  VITE_QA_BUILD_SEQUENCE: "400",
};

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
  it("publishes V3 store builds for desktop Firefox only while Firefox for Android is deferred", () => {
    const gecko = {
      id: "still@chartash.com",
      strict_min_version: "140.0",
      data_collection_permissions: {
        required: ["authenticationInfo"],
        optional: ["technicalAndInteraction"],
      },
    };
    expect(firefoxBrowserSpecificSettings).toEqual({ gecko });
    // Owner decision, 20 Oct 2026. Flipping this is the deliberate step that lists Android on AMO.
    expect(FIREFOX_ANDROID_RELEASE_DEFERRED).toBe(true);
    for (const env of [UNCONFIGURED, CONFIGURED_V3, RELEASE_V3]) {
      expect(stillManifest("firefox", env)).toHaveProperty("browser_specific_settings", { gecko });
      expect(JSON.stringify(stillManifest("firefox", env))).not.toContain("gecko_android");
      expect(declaresFirefoxAndroid(env)).toBe(false);
    }
  });

  it("keeps the unlisted sandbox QA package installable on Firefox for Android for the emulator lane", () => {
    expect(declaresFirefoxAndroid(SANDBOX_QA)).toBe(true);
    expect(stillManifest("firefox", SANDBOX_QA)).toHaveProperty("browser_specific_settings", {
      gecko: { ...firefoxBrowserSpecificSettings.gecko, id: "still-qa-sandbox@chartash.com" },
      gecko_android: { strict_min_version: "142.0" },
    });
  });

  it("never lists a configured 2.x build (the pre-V3 interface) for Android", () => {
    expect(stillManifest("firefox", CONFIGURED_2X)).toHaveProperty("browser_specific_settings", firefoxBrowserSpecificSettings);
    expect(JSON.stringify(stillManifest("firefox", CONFIGURED_2X))).not.toContain("gecko_android");
    expect(declaresFirefoxAndroid(CONFIGURED_2X)).toBe(false);
  });

  it("names Firefox on Android in the summary only for builds listed for Android", () => {
    // The 2.x store summary, byte-for-byte as it shipped before Firefox for Android. While Android
    // is deferred, V3 store builds keep it too (owner decision, 20 Oct 2026).
    const shipped2x =
      "Remove YouTube Shorts and Instagram & Facebook Reels, and block the TikTok website. Free, with no timers or stats. Sign in free to sync your settings with Chrome and with Safari on iPhone, iPad and Mac. Desktop Firefox.";
    for (const env of [CONFIGURED_2X, UNCONFIGURED, CONFIGURED_V3, RELEASE_V3]) {
      expect(stillManifest("firefox", env).description, JSON.stringify(env)).toBe(shipped2x);
      expect(stillManifest("firefox", env).description).not.toContain("Android");
    }
    // The sandbox QA package, listed for Android, keeps the V3 wording unchanged.
    expect(stillManifest("firefox", SANDBOX_QA).description).toBe(
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

  it("opens Settings in its own tab on Firefox only (ISS-0097)", () => {
    // What WXT generates from the options entrypoint before the hook runs.
    const generated = () => ({ options_ui: { page: "options.html", open_in_tab: false } });
    expect(settingsPageHost("firefox", generated()).options_ui).toEqual({
      page: "options.html",
      open_in_tab: true,
    });
    for (const browser of ["chrome", "chromium", "edge", "safari"])
      expect(settingsPageHost(browser, generated()).options_ui).toEqual({
        page: "options.html",
        open_in_tab: false,
      });
    // A build without an options entrypoint has nothing to place.
    expect(settingsPageHost("firefox", {})).toEqual({});
  });

  describe("the manifest the build generates (config.manifest, then build:manifestGenerated)", () => {
    afterEach(() => vi.unstubAllEnvs());

    /** What WXT writes for Firefox: the config's manifest callback under `env`, then the hook. */
    async function generatedFirefoxManifest(env: ManifestBuildEnv) {
      vi.stubEnv("VITE_SUPABASE_URL", "");
      vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
      vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "");
      vi.stubEnv("VITE_PACKAGE_IDENTITY", "");
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value ?? "");
      const build = config.manifest as (env: { browser: string }) => Record<string, unknown>;
      const manifest: Record<string, unknown> = {
        ...build({ browser: "firefox" }),
        options_ui: { page: "options.html", open_in_tab: false },
      };
      const hook = (config.hooks as Record<string, (wxt: unknown, manifest: unknown) => unknown>)["build:manifestGenerated"];
      if (typeof hook !== "function") throw new Error("the build:manifestGenerated hook is not wired");
      await hook({ config: { browser: "firefox" } }, manifest);
      return manifest;
    }

    it("has no gecko_android in the release Firefox manifest", async () => {
      for (const env of [RELEASE_V3, UNCONFIGURED, CONFIGURED_2X]) {
        const manifest = await generatedFirefoxManifest(env);
        expect(manifest.browser_specific_settings).toEqual(firefoxBrowserSpecificSettings);
        expect(manifest).not.toHaveProperty("browser_specific_settings.gecko_android");
        expect(manifest.options_ui).toEqual({ page: "options.html", open_in_tab: true });
        expect(manifest.description).toBe(FIREFOX_2X_DESCRIPTION);
      }
    });

    it("keeps gecko_android in the sandbox QA Firefox manifest", async () => {
      const manifest = await generatedFirefoxManifest(SANDBOX_QA);
      expect(manifest).toHaveProperty("browser_specific_settings.gecko.id", "still-qa-sandbox@chartash.com");
      expect(manifest).toHaveProperty("browser_specific_settings.gecko_android", { strict_min_version: "142.0" });
      expect(manifest.description).toBe(FIREFOX_V3_DESCRIPTION);
    });
  });

  it("wires that host rule into the generated manifest (the build hook)", async () => {
    const hooks = config.hooks as Record<string, (wxt: unknown, manifest: unknown) => unknown>;
    const hook = hooks["build:manifestGenerated"];
    if (typeof hook !== "function") throw new Error("the build:manifestGenerated hook is not wired");
    for (const [browser, open] of [["firefox", true], ["chrome", false]] as const) {
      const manifest = { options_ui: { page: "options.html", open_in_tab: false } };
      await hook({ config: { browser } }, manifest);
      expect(manifest.options_ui.open_in_tab).toBe(open);
    }
  });
});
