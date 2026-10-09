import { describe, expect, it } from "vitest";
import {
  QA_SANDBOX_PACKAGE,
  qaPackageVersion,
  qaSandboxPackage,
  stillManifest,
  type ManifestBuildEnv,
} from "../../wxt.config";

// The paid-sandbox profile (scripts/qa/v3-profile.mjs) sets all three together.
const SANDBOX_QA: ManifestBuildEnv = {
  VITE_PACKAGE_IDENTITY: "paid-sandbox-qa",
  VITE_BACKEND_ROUTE_PROFILE: "shared-hosted-sandbox",
  VITE_ACCESS_ENVIRONMENT: "sandbox",
  VITE_QA_BUILD_SEQUENCE: "306",
};

describe("sandbox QA package identity", () => {
  it("gives Firefox sandbox QA builds their own add-on id and a visibly non-release name", () => {
    const manifest = stillManifest("firefox", SANDBOX_QA);
    expect(manifest).toHaveProperty(
      "browser_specific_settings.gecko.id",
      "still-qa-sandbox@chartash.com",
    );
    expect(manifest.name).toBe("Still QA Sandbox (not for release)");
    // Firefox's validator caps the name at 45 characters.
    expect(manifest.name.length).toBeLessThanOrEqual(45);
    // Everything else about the Firefox listing settings is unchanged.
    expect(manifest).toHaveProperty(
      "browser_specific_settings.gecko.strict_min_version",
      "140.0",
    );
    expect(manifest).toHaveProperty(
      "browser_specific_settings.gecko_android.strict_min_version",
      "142.0",
    );
  });

  it("labels and numbers the Chrome sandbox QA build without changing its permissions", () => {
    const { version, ...qa } = stillManifest("chrome", SANDBOX_QA);
    const ordinary = stillManifest("chrome", {});
    expect(qa.name).toBe(QA_SANDBOX_PACKAGE.name);
    expect(version).toMatch(/\.306$/);
    expect({ ...qa, name: ordinary.name }).toEqual(ordinary);
  });

  it("leaves ordinary and store builds on the permanent store identity", () => {
    for (const env of [
      {},
      { VITE_PACKAGE_IDENTITY: "" },
      { VITE_BACKEND_ROUTE_PROFILE: "shared-hosted-sandbox" },
    ]) {
      const manifest = stillManifest("firefox", env);
      expect(manifest).toHaveProperty(
        "browser_specific_settings.gecko.id",
        "still@chartash.com",
      );
      expect(manifest.name).toBe(
        "Still: Remove Shorts & Reels, Stop Scrolling",
      );
      expect(qaSandboxPackage(env)).toBe(false);
    }
  });

  it("refuses an unknown identity or a QA identity without the sandbox route and access trust", () => {
    expect(() =>
      qaSandboxPackage({ VITE_PACKAGE_IDENTITY: "production" }),
    ).toThrow(/VITE_PACKAGE_IDENTITY/);
    expect(() =>
      qaSandboxPackage({
        ...SANDBOX_QA,
        VITE_BACKEND_ROUTE_PROFILE: "production",
      }),
    ).toThrow(/sandbox/);
    expect(() =>
      qaSandboxPackage({
        ...SANDBOX_QA,
        VITE_BACKEND_ROUTE_PROFILE: undefined,
      }),
    ).toThrow(/sandbox/);
    expect(() =>
      qaSandboxPackage({
        ...SANDBOX_QA,
        VITE_ACCESS_ENVIRONMENT: "production",
      }),
    ).toThrow(/sandbox/);
    expect(() =>
      stillManifest("firefox", { VITE_PACKAGE_IDENTITY: "paid-sandbox-qa" }),
    ).toThrow(/sandbox/);
  });

  it("numbers each sandbox QA package with a fourth, source-derived part so Mozilla can sign every new build", () => {
    for (const browser of ["firefox", "chrome"]) {
      expect(stillManifest(browser, SANDBOX_QA)).toHaveProperty("version", expect.stringMatching(/^\d+\.\d+\.\d+\.306$/));
    }
    expect(qaPackageVersion({ VITE_QA_BUILD_SEQUENCE: "65535" }, "2.1.1")).toBe("2.1.1.65535");
    for (const sequence of [undefined, "", "0", "012", "65536", "1.2", "abc"]) {
      expect(() => stillManifest("firefox", { ...SANDBOX_QA, VITE_QA_BUILD_SEQUENCE: sequence })).toThrow(/VITE_QA_BUILD_SEQUENCE/);
    }
    expect(() => qaPackageVersion(SANDBOX_QA, "2.1")).toThrow(/three parts/);
    // Store builds keep the package.json version (WXT's default); no QA suffix leaks into them.
    expect(stillManifest("firefox", { VITE_QA_BUILD_SEQUENCE: "306" })).not.toHaveProperty("version");
  });
});
