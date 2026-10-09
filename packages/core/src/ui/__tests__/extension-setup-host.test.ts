import { afterEach, describe, expect, it, vi } from "vitest";
import { PAID_TIER_ENABLED } from "@still/shared-types";
import type { AccessHost, AccessPlatform, TrustedAccessContext } from "../../entitlement/access-policy.js";

// The popup, options and first-run pages show the access snapshot their entitlement cache holds
// until the background answers (and keep it when the background cannot answer). That snapshot is
// resolved for the page's own host, so once paid is on a Still Pro extra the build implements is
// never shown as "Not available in this browser" by the host-less default. Paid off every host
// resolves to exactly the free features. Observed by wrapping the real function, never replacing it.

const seen = vi.hoisted(() => ({
  calls: [] as { host: AccessHost | undefined; platform: AccessPlatform | undefined; result: TrustedAccessContext }[],
}));
vi.mock("../../entitlement/access-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../entitlement/access-policy.js")>();
  return { ...actual, packagedAccessContext: (host?: AccessHost, platform?: AccessPlatform) => {
    const result = actual.packagedAccessContext(host, platform);
    seen.calls.push({ host, platform, result });
    return result;
  } };
});

const { createExtensionUiController } = await import("../extension-setup.js");
const { initialAccessSnapshot } = await import("../../entitlement/access-policy.js");

function installChrome(): void {
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    // The background never answers: the page keeps the snapshot it was seeded with.
    runtime: { id: "synthetic", getURL: () => "chrome-extension://synthetic/", sendMessage: () => Promise.resolve(undefined) },
  });
}

afterEach(() => {
  seen.calls.length = 0;
  vi.unstubAllGlobals();
});

describe("extension pages resolve their access for their own host", () => {
  for (const host of ["chromium", "firefox", "safari"] as const)
    it(`${host}: the committed popup's access comes from packagedAccessContext("${host}")`, () => {
      installChrome();
      let access: unknown;
      createExtensionUiController(undefined, {
        accessHost: host,
        onCommittedPopupBinding: (binding) => { access = binding.current().access; },
      });
      // Hosts that span phones seed an unknown platform until the browser answers.
      expect(seen.calls.map((call) => [call.host, call.platform])).toEqual([[host, host === "chromium" ? undefined : "unknown"]]);
      expect(seen.calls[0]!.result.paidMode).toBe(PAID_TIER_ENABLED);
      expect(access).toEqual(initialAccessSnapshot(seen.calls[0]!.result));
    });

  it("forwards the runtime platform seam", () => {
    installChrome();
    createExtensionUiController(undefined, { accessHost: "firefox", accessPlatform: "android" });
    expect(seen.calls.map((call) => [call.host, call.platform])).toEqual([["firefox", "android"]]);
  });

  it("a pending platform answer seeds unknown, then reseeds the page with the browser's answer", async () => {
    installChrome();
    let answer!: (platform: AccessPlatform) => void;
    createExtensionUiController(undefined, { accessHost: "firefox", accessPlatform: new Promise((resolve) => { answer = resolve; }) });
    expect(seen.calls.map((call) => [call.host, call.platform])).toEqual([["firefox", "unknown"]]);
    answer("android");
    await Promise.resolve(); await Promise.resolve();
    expect(seen.calls.map((call) => [call.host, call.platform])).toEqual([["firefox", "unknown"], ["firefox", "android"]]);
  });

  it("a failed platform answer keeps the unknown-platform seed", async () => {
    installChrome();
    createExtensionUiController(undefined, { accessHost: "safari", accessPlatform: Promise.reject(new Error("no answer")) });
    await Promise.resolve(); await Promise.resolve();
    expect(seen.calls.map((call) => [call.host, call.platform])).toEqual([["safari", "unknown"]]);
  });

  it("without a host it keeps the host-less default (only features every host implements)", () => {
    installChrome();
    createExtensionUiController();
    expect(seen.calls.map((call) => [call.host, call.platform])).toEqual([[undefined, undefined]]);
  });
});
