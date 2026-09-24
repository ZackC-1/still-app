import { describe, expect, it } from "vitest";
import {
  firefoxBrowserSpecificSettings,
  stillManifest,
} from "../../wxt.config";

describe("Firefox manifest compatibility", () => {
  it("publishes the launch build for desktop Firefox only", () => {
    expect(firefoxBrowserSpecificSettings).toEqual({
      gecko: {
        id: "still@chartash.com",
        strict_min_version: "140.0",
        data_collection_permissions: {
          required: ["authenticationInfo"],
          optional: ["technicalAndInteraction"],
        },
      },
    });
    expect(firefoxBrowserSpecificSettings).not.toHaveProperty("gecko_android");
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
