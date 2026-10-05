import { describe, expect, it } from "vitest";
import {
  firefoxBrowserSpecificSettings,
  stillManifest,
} from "../../wxt.config";

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
  it("publishes the Firefox build for desktop Firefox and Firefox for Android", () => {
    expect(firefoxBrowserSpecificSettings).toEqual({
      gecko: {
        id: "still@chartash.com",
        strict_min_version: "140.0",
        data_collection_permissions: {
          required: ["authenticationInfo"],
          optional: ["technicalAndInteraction"],
        },
      },
      gecko_android: {
        strict_min_version: "142.0",
      },
    });
    expect(stillManifest("firefox")).toHaveProperty("browser_specific_settings", firefoxBrowserSpecificSettings);
  });

  it("never lets Android install below 142, the first release with the built-in data consent screen", () => {
    // Firefox for Android 141 and older show no data-collection consent at install. Still declares
    // required sign-in data, so a lower floor would let someone sign in without that screen.
    expect(major(firefoxBrowserSpecificSettings.gecko_android.strict_min_version)).toBeGreaterThanOrEqual(142);
    // Desktop keeps its own floor (140, the desktop consent screen); Android is never below it.
    expect(major(firefoxBrowserSpecificSettings.gecko.strict_min_version)).toBeGreaterThanOrEqual(140);
  });

  it("adds no permission and no host for Android: the same four sites, storage and alarms only", () => {
    const manifest = stillManifest("firefox") as Record<string, unknown>;
    expect(manifest.permissions).toEqual(["storage", "alarms"]);
    expect(manifest.host_permissions).toEqual(FOUR_HOSTS);
    expect(manifest).not.toHaveProperty("optional_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest).not.toHaveProperty("declarative_net_request");
    expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
    expect(JSON.stringify(manifest)).not.toContain("declarativeNetRequest");
  });

  it("keeps the Chromium manifest exactly as it was: no Firefox or Android key leaks into it", () => {
    const chrome = stillManifest("chrome");
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
    expect(stillManifest("firefox").description.length).toBeLessThanOrEqual(250);
  });
});
