import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type BenefitId } from "@still/shared-types";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { createContentScript, type ContentScriptHandle } from "../index.js";
import { createEnginePageSession } from "../../rules/engine.js";
import { initialAccessSnapshot } from "../../entitlement/access-policy.js";
import { ruleSet, on } from "../../rules/__tests__/format2-fixtures.js";
import seed from "../../../rules/seed.json";
import type { SignedRuleSet, SignedRuleSetV2 } from "@still/shared-types";
const scripts: ContentScriptHandle[] = [];
const cores = new Set<BenefitId>([
  "youtube.shorts",
  "instagram.reels",
  "facebook.reels",
  "tiktok.all",
]);
const allCores: SignedRuleSetV2 = {
  ...ruleSet,
  services: {
    ...ruleSet.services,
    facebook: {
      matches: ["*://*.facebook.com/*"],
      surfaces: [
        {
          id: "fixture-only-fb",
          feature: "facebook.reels",
          action: "hide",
          selectors: [".fixture-only-reel"],
        },
      ],
    },
  },
};
const access = initialAccessSnapshot({ paidMode: false, supported: cores });
afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
  vi.restoreAllMocks();
});
async function host(
  href = "https://www.youtube.com/",
  blocked?: (target: URL) => boolean,
) {
  const storage = new InMemoryStorageAdapter({
    ...DEFAULT_SETTINGS,
    updatedAt: 1,
  });
  const writer = new AtomicSettingsWriter(storage);
  await writer.initialize("never-linked");
  const cache = new SettingsCache(storage);
  let current = href;
  const entries = [href];
  let cursor = 0;
  const replace = vi.fn((url: string) => {
    current = url;
    entries[cursor] = url;
  });
  const assign = vi.fn((url: string) => {
    current = url;
    entries.splice(++cursor);
    entries.push(url);
  });
  const push = vi.fn(
    (_data: unknown, _unused: string, url?: string | URL | null) => {
      if (url != null) {
        current = new URL(url, current).href;
        entries.splice(++cursor);
        entries.push(current);
      }
    },
  );
  const replaceState = vi.fn(
    (_data: unknown, _unused: string, url?: string | URL | null) => {
      if (url != null) {
        current = new URL(url, current).href;
        entries[cursor] = current;
      }
    },
  );
  const listeners = new Map<string, () => void>();
  let navigate:
    | ((event?: {
        destination?: { url: string };
        cancelable?: boolean;
        isTrusted?: boolean;
        navigationType?: "push" | "replace" | "reload" | "traverse";
        preventDefault?: () => void;
      }) => void)
    | undefined;
  let success: typeof navigate;
  const win = {
    location: {
      get href() {
        return current;
      },
      replace,
      assign,
    },
    history: { pushState: push, replaceState },
    addEventListener: (name: string, cb: () => void) => {
      listeners.set(name, cb);
    },
    removeEventListener: (name: string) => {
      listeners.delete(name);
    },
    MutationObserver: window.MutationObserver,
    navigation: {
      addEventListener: (
        name: "navigate" | "navigatesuccess",
        cb: typeof navigate,
      ) => {
        if (name === "navigate") navigate = cb;
        else success = cb;
      },
      removeEventListener: (name: "navigate" | "navigatesuccess") => {
        if (name === "navigate") navigate = undefined;
        else success = undefined;
      },
    },
  };
  const script = createContentScript({
    win,
    doc: document,
    ruleSet: seed as unknown as SignedRuleSet,
    ruleSetV2: allCores,
    capabilities: cores,
    cache,
    handleBlockedNavigation: blocked,
  });
  scripts.push(script);
  await script.start();
  return {
    win,
    writer,
    replace,
    assign,
    entries,
    back: () => {
      current = entries[--cursor]!;
      listeners.get("popstate")?.();
      return current;
    },
    push,
    replaceState,
    cache,
    script,
    navigate: (target: string, options = {}) => {
      const preventDefault = vi.fn();
      navigate?.({
        destination: { url: target },
        cancelable: true,
        isTrusted: true,
        navigationType: "push",
        preventDefault,
        ...options,
      });
      return preventDefault;
    },
    listeners,
    success: () => success?.(),
  };
}
describe("same compiled effective predicate for packaged navigation", () => {
  it("normalizes Shorts to a normal player while preserving deliberate playlist/share/time context", () => {
    const session = createEnginePageSession(allCores);
    expect(
      session.evaluate(
        on,
        new URL(
          "https://m.youtube.com/shorts/abc?list=chosen&index=2&v=wrong&v=also&si=share&t=30#time",
        ),
        { access, capabilities: cores },
      ),
    ).toEqual({
      kind: "redirect",
      url: "https://m.youtube.com/watch?list=chosen&index=2&v=abc&si=share&t=30#time",
    });
    session.stop?.();
  });
  it.each([
    "https://www.youtube.com/watch?v=abc&list=chosen",
    "https://www.youtube.com/results?search_query=shorts",
    "https://www.youtube.com/shorts/a%2Fb",
    "https://www.instagram.com/reel/shared/?igsh=known",
    "https://www.instagram.com/direct/inbox/",
    "https://www.facebook.com/reel/shared/",
    "https://www.facebook.com/watch/?v=live",
    "https://www.facebook.com/people/Reels/123",
  ])("preserves deliberate/ordinary route %s", (href) => {
    const session = createEnginePageSession(allCores);
    expect(
      session.evaluate(on, new URL(href), { access, capabilities: cores }).kind,
    ).toBe("apply");
    session.stop?.();
  });
  it.each(["instagram", "facebook"])(
    "only the packaged bare %s Reels category goes to its same-origin home",
    (service) => {
      const session = createEnginePageSession(allCores);
      expect(
        session.evaluate(
          on,
          new URL(`https://www.${service}.com/reels/?entry=nav`),
          { access, capabilities: cores },
        ),
      ).toEqual({ kind: "redirect", url: `https://www.${service}.com/` });
      session.stop?.();
    },
  );
  it("Off, unsupported or held access never redirects; no extra capability is granted", () => {
    const session = createEnginePageSession(allCores);
    const target = new URL("https://www.youtube.com/shorts/abc");
    expect(
      session.evaluate(
        { ...on, sites: { ...on.sites, "youtube.shorts": false } },
        target,
        { access, capabilities: cores },
      ).kind,
    ).toBe("noop");
    expect(
      session.evaluate(on, target, { access, capabilities: new Set() }).kind,
    ).toBe("noop");
    expect(
      session.evaluate(on, target, {
        access: {
          ...access,
          states: { ...access.states, "youtube.shorts": "checking" },
        },
        capabilities: cores,
      }).kind,
    ).toBe("noop");
    session.stop?.();
  });
});
describe("actual modern content navigation consumer", () => {
  it("redirects initial URL once through committed settings and ignores later same-target reapply", async () => {
    const h = await host("https://www.youtube.com/shorts/abc?list=chosen");
    expect(h.replace).toHaveBeenCalledExactlyOnceWith(
      "https://www.youtube.com/watch?list=chosen&v=abc",
    );
    h.script.reapply();
    expect(h.replace).toHaveBeenCalledTimes(1);
  });
  it("classifies push/replace targets before the original history method mutates the page", async () => {
    const h = await host();
    h.win.history.pushState({}, "", "/shorts/abc?list=chosen");
    expect(h.push).not.toHaveBeenCalled();
    expect(h.assign).toHaveBeenLastCalledWith(
      "https://www.youtube.com/watch?list=chosen&v=abc",
    );
    h.win.history.replaceState({}, "", "/shorts/next");
    expect(h.replaceState).not.toHaveBeenCalled();
    expect(h.replace).toHaveBeenLastCalledWith(
      "https://www.youtube.com/watch?v=next",
    );
    h.win.history.pushState({}, "", "/watch?v=normal");
    expect(h.push).toHaveBeenCalledTimes(1);
    h.win.history.pushState({}, "", "/shorts/abc?list=chosen");
    expect(h.assign).toHaveBeenCalledTimes(2);
    expect(h.replace).toHaveBeenCalledTimes(1);
    await h.writer.commit({
      path: "sites.youtube.shorts",
      value: false,
      updatedAt: 2,
    });
    h.win.history.pushState({}, "", "/shorts/allowed");
    expect(h.push).toHaveBeenCalledTimes(2);
  });
  it("Navigation API destination uses the same consumer, while uncancellable or synthetic notifications never cause pretransition action", async () => {
    const h = await host();
    expect(
      h.navigate("https://www.youtube.com/shorts/abc"),
    ).toHaveBeenCalledOnce();
    expect(h.assign).toHaveBeenCalledOnce();
    h.navigate("https://www.youtube.com/shorts/next", { cancelable: false });
    h.navigate("https://www.youtube.com/shorts/next", { isTrusted: false });
    expect(h.assign).toHaveBeenCalledOnce();
  });
  it.each(["youtube", "facebook"])(
    "consumed %s pushes preserve the origin history entry and Back destination",
    async (service) => {
      const origin =
        service === "youtube"
          ? "https://www.youtube.com/results?search_query=chosen"
          : "https://www.facebook.com/profile.php?id=chosen";
      const target = service === "youtube" ? "/shorts/chosen" : "/reels/";
      const expected =
        service === "youtube"
          ? "https://www.youtube.com/watch?v=chosen"
          : "https://www.facebook.com/";
      const h = await host(origin);
      h.win.history.pushState({ keep: true }, "", target);
      expect(h.entries).toEqual([origin, expected]);
      expect(h.push).not.toHaveBeenCalled();
      expect(h.replace).not.toHaveBeenCalled();
      expect(h.back()).toBe(origin);
    },
  );
  it("Navigation API replacement intent replaces only the current entry", async () => {
    const h = await host("https://www.youtube.com/results?search_query=chosen");
    h.win.history.pushState({ state: "ordinary" }, "", "/watch?v=ordinary");
    expect(
      h.navigate("https://www.youtube.com/shorts/next", {
        navigationType: "replace",
      }),
    ).toHaveBeenCalledOnce();
    expect(h.entries).toEqual([
      "https://www.youtube.com/results?search_query=chosen",
      "https://www.youtube.com/watch?v=next",
    ]);
    expect(h.assign).not.toHaveBeenCalled();
    expect(h.back()).toBe(
      "https://www.youtube.com/results?search_query=chosen",
    );
  });
  it("does not reapply a stale blocked URL while its normal replacement navigation is still precommit", async () => {
    const h = await host();
    h.push({}, "", "/shorts/stale");
    h.navigate("https://www.youtube.com/watch?v=stale");
    expect(h.replace).not.toHaveBeenCalled();
    h.push({}, "", "/watch?v=stale");
    h.success();
    expect(h.replace).not.toHaveBeenCalled();
  });
  it("preserves cross-origin history rejection and never redirects it on behalf of the native method", async () => {
    const h = await host();
    h.push.mockImplementationOnce(() => {
      throw new DOMException("Cross-origin", "SecurityError");
    });
    expect(() =>
      h.win.history.pushState({}, "", "https://m.youtube.com/shorts/abc"),
    ).toThrow("Cross-origin");
    expect(h.replace).not.toHaveBeenCalled();
  });
  it("TikTok decision holds without a real screen adapter and never renders the legacy placeholder", async () => {
    document.body.innerHTML =
      '<div id="ordinary">Keep until actual screen handler</div>';
    const h = await host("https://www.tiktok.com/foryou");
    expect(h.replace).not.toHaveBeenCalled();
    expect(document.getElementById("ordinary")).not.toBeNull();
    expect(document.getElementById("still-placeholder")).toBeNull();
  });
  it("stop restores exact history methods and cannot overwrite a later wrapper or process later settings", async () => {
    const h = await host();
    const later = vi.fn();
    h.win.history.replaceState = later;
    h.script.stop();
    expect(h.win.history.pushState).toBe(h.push);
    expect(h.win.history.replaceState).toBe(later);
    expect(h.listeners.size).toBe(0);
    await h.writer.commit({ path: "globalOn", value: false, updatedAt: 2 });
    h.script.reapply();
    expect(h.replace).not.toHaveBeenCalled();
  });
});
