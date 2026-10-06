import { afterEach, describe, expect, it, vi } from "vitest";
import { PAID_TIER_ENABLED } from "@still/shared-types";
import { initialAccessSnapshot, type AccessHost, type AccessPlatform, type TrustedAccessContext } from "../../entitlement/access-policy.js";
import type { ContentScriptDeps, ContentScriptHandle } from "../index.js";

// The content entry hands the engine the capabilities of the host it runs in, so a Still Pro
// extra implemented on Chromium/Firefox (and not Safari) can count there once paid is on. While
// paid is off every host's set is exactly the free features (dormancy). Observed by wrapping the
// real functions, never replacing them.

const seen = vi.hoisted(() => ({
  deps: [] as ContentScriptDeps[],
  calls: [] as { host: AccessHost | undefined; platform: AccessPlatform | undefined; result: TrustedAccessContext }[],
}));
vi.mock("../index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../index.js")>();
  return { ...actual, createContentScript: (deps: ContentScriptDeps) => {
    seen.deps.push(deps);
    return actual.createContentScript(deps);
  } };
});
vi.mock("../../entitlement/access-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../entitlement/access-policy.js")>();
  return { ...actual, packagedAccessContext: (host?: AccessHost, platform?: AccessPlatform) => {
    const result = actual.packagedAccessContext(host, platform);
    seen.calls.push({ host, platform, result });
    return result;
  } };
});

const { createExtensionContentEntry, createShippingContentEntry } = await import("../extension-entry.js");
const { createModernShippingContentEntry } = await import("../modern-shipping-entry.js");
const { createFormat2EntryHost } = await import("./format2-entry-host.js");
const { PACKAGED_RULE_SET_V2 } = await import("../../rules/packaged.js");

const FREE = ["facebook.reels", "instagram.reels", "tiktok.all", "youtube.shorts"];
const started = new Set<ContentScriptHandle>();
const storage = { get: () => Promise.resolve({}), set: () => Promise.resolve() };

function installChrome(): void {
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    runtime: { sendMessage: () => Promise.resolve(undefined) },
  });
}
function makeWin(href: string) {
  return {
    location: { href, replace: vi.fn() },
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
  };
}

afterEach(() => {
  for (const script of started) script.stop();
  started.clear();
  seen.deps.length = 0;
  seen.calls.length = 0;
  vi.unstubAllGlobals();
});

describe("content entry host capabilities", () => {
  for (const host of ["chromium", "firefox", "safari", undefined] as (AccessHost | undefined)[]) {
    it(`passes the ${host ?? "unknown"} host's capabilities to the engine (free-only while paid is off)`, async () => {
      installChrome();
      await createExtensionContentEntry({
        host, storage, prod: false, earlyRedirect: false,
        win: makeWin("https://www.youtube.com/watch?v=x") as never,
        onScriptCreated: (script) => started.add(script),
      })();
      expect(seen.deps).toHaveLength(1);
      const call = seen.calls.find((entry) => entry.result.supported === seen.deps[0]!.capabilities);
      expect(call, "the engine receives exactly the set packagedAccessContext returned").toBeDefined();
      expect(call!.result.paidMode).toBe(PAID_TIER_ENABLED);
      expect([call!.host, call!.platform]).toEqual([host, undefined]);
      expect([...seen.deps[0]!.capabilities!].sort()).toEqual(FREE);
      // The access the script holds until the background answers is resolved for the same host.
      expect(seen.deps[0]!.entitlement!.currentAccessSnapshot()).toEqual(initialAccessSnapshot(call!.result));
    });
  }

  it("the shipping entry forwards the host on the lane it picks", async () => {
    installChrome();
    await createShippingContentEntry({
      host: "firefox", storage, prod: false, earlyRedirect: false,
      win: makeWin("https://www.youtube.com/watch?v=x") as never,
      onScriptCreated: (script) => started.add(script),
    })();
    expect(seen.deps).toHaveLength(1);
    const call = seen.calls.find((entry) => entry.result.supported === seen.deps[0]!.capabilities);
    expect([call!.host, call!.platform]).toEqual(["firefox", undefined]);
  });

  it("forwards the runtime platform seam with the host (Firefox for Android)", async () => {
    installChrome();
    await createShippingContentEntry({
      host: "firefox", platform: "android", storage, prod: false, earlyRedirect: false,
      win: makeWin("https://www.youtube.com/watch?v=x") as never,
      onScriptCreated: (script) => started.add(script),
    })();
    const call = seen.calls.find((entry) => entry.result.supported === seen.deps[0]!.capabilities);
    expect([call!.host, call!.platform]).toEqual(["firefox", "android"]);
    // Paid off the platform changes nothing: still exactly the free features.
    expect([...seen.deps[0]!.capabilities!].sort()).toEqual(FREE);
  });

  it("the shipping entry's early Shorts redirect resolves its access for the same host", async () => {
    installChrome();
    await createShippingContentEntry({
      host: "firefox", storage, prod: false, earlyRedirect: true,
      win: makeWin("https://www.youtube.com/shorts/abc") as never,
      onScriptCreated: (script) => started.add(script),
    })();
    expect(seen.calls.length).toBeGreaterThan(0);
    // Every context this page resolved (early redirect, entitlement seed, engine) names the host.
    for (const call of seen.calls) expect([call.host, call.platform]).toEqual(["firefox", undefined]);
  });

  // U7-W3: the V3 entry (Firefox and Safari V3 builds) mirrors the shipping entry's lane choice and
  // must resolve every access context for its host, including on a Safari page with the pending
  // cover and in its early core-route redirect.
  it.each([
    ["firefox", false, "https://www.youtube.com/watch?v=x"],
    ["safari", true, "https://www.youtube.com/watch?v=x"],
    ["safari", true, "https://www.instagram.com/reels/"],
  ] as const)("the V3 entry forwards the %s host (cover %s) on %s", async (host, pendingCover, href) => {
    installChrome();
    await createModernShippingContentEntry({
      host, pendingCover, storage, prod: false, earlyRedirect: false,
      win: makeWin(href) as never,
      onScriptCreated: (script) => started.add(script),
    })();
    expect(seen.deps).toHaveLength(1);
    const call = seen.calls.find((entry) => entry.result.supported === seen.deps[0]!.capabilities);
    expect([call!.host, call!.platform]).toEqual([host, undefined]);
    expect([...seen.deps[0]!.capabilities!].sort()).toEqual(FREE);
    expect(seen.deps[0]!.entitlement!.currentAccessSnapshot()).toEqual(initialAccessSnapshot(call!.result));
  });

  it.each([
    ["firefox", undefined, "youtube.html", "https://www.youtube.com/shorts/abc", "https://www.youtube.com/watch?v=abc"],
    ["safari", undefined, "instagram-home.html", "https://www.instagram.com/reels/", "https://www.instagram.com/"],
    ["firefox", "android", "facebook.html", "https://www.facebook.com/watch/reels/", "https://www.facebook.com/"],
  ] as const)("the V3 entry's early core-route redirect resolves its access for the %s host (platform %s)",
    async (host, platform, file, href, destination) => {
      // Saved schema-2 settings, so the page takes the format-2 lane and its early decision.
      const scripts: ContentScriptHandle[] = [];
      const h = await createFormat2EntryHost(PACKAGED_RULE_SET_V2 as never, file, href, scripts);
      const area = (globalThis as unknown as { chrome: { storage: { local: typeof storage } } }).chrome.storage.local;
      seen.calls.length = 0;
      await createModernShippingContentEntry({
        host, platform, pendingCover: host === "safari", storage: area, prod: false, earlyRedirect: true,
        win: h.win, doc: document,
        onScriptCreated: (script) => { started.add(script); scripts.push(script); },
      })();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.replace).toHaveBeenCalledWith(destination);
      // The early decision, the entitlement seed and the engine: all resolved for this host.
      expect(seen.calls.length).toBeGreaterThanOrEqual(2);
      for (const call of seen.calls) expect([call.host, call.platform]).toEqual([host, platform]);
      document.documentElement.className = "";
      document.body.innerHTML = "";
    });
});
