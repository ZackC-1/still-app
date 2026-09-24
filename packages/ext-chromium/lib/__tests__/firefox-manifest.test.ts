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
});
