import { afterEach, describe, expect, it, vi } from "vitest";
import { PAID_TIER_ENABLED, type BenefitId } from "@still/shared-types";
import type { AccessCapabilityInput, AccessHost } from "../../entitlement/access-policy.js";
import type { ContentScriptDeps, ContentScriptHandle } from "../index.js";

// The content entry hands the engine the capabilities of the host it runs in, so a Still Pro
// extra implemented on Chromium/Firefox (and not Safari) can count there once paid is on. While
// paid is off every host's set is exactly the free features (dormancy). Observed by wrapping the
// real functions, never replacing them.

const seen = vi.hoisted(() => ({
  deps: [] as ContentScriptDeps[],
  calls: [] as { input: AccessCapabilityInput; result: ReadonlySet<BenefitId> }[],
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
  return { ...actual, accessCapabilities: (input: AccessCapabilityInput) => {
    const result = actual.accessCapabilities(input);
    seen.calls.push({ input: { ...input }, result });
    return result;
  } };
});

const { createExtensionContentEntry, createShippingContentEntry } = await import("../extension-entry.js");
const { createModernShippingContentEntry } = await import("../modern-shipping-entry.js");

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
      const call = seen.calls.find((entry) => entry.result === seen.deps[0]!.capabilities);
      expect(call, "the engine receives exactly the set accessCapabilities returned").toBeDefined();
      expect(call!.input).toEqual({ paidMode: PAID_TIER_ENABLED, host });
      expect([...seen.deps[0]!.capabilities!].sort()).toEqual(FREE);
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
    const call = seen.calls.find((entry) => entry.result === seen.deps[0]!.capabilities);
    expect(call!.input).toEqual({ paidMode: PAID_TIER_ENABLED, host: "firefox" });
  });

  // U7-W3: the V3 entry (Firefox and Safari V3 builds) mirrors the shipping entry's lane choice and
  // must forward the host the same way, including on a Safari page that has the pending cover.
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
    const call = seen.calls.find((entry) => entry.result === seen.deps[0]!.capabilities);
    expect(call!.input).toEqual({ paidMode: PAID_TIER_ENABLED, host });
    expect([...seen.deps[0]!.capabilities!].sort()).toEqual(FREE);
  });
});
