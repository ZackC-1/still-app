import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type BenefitId } from "@still/shared-types";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { createContentScript, type ContentScriptHandle } from "../index.js";
import { createEnginePageSession } from "../../rules/engine.js";
import { instagramViewerShowsReel } from "../../rules/instagram.js";
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

describe("Facebook's own Reels feed under Watch (category browsing)", () => {
  it.each([
    "https://www.facebook.com/watch/reels",
    "https://www.facebook.com/watch/reels/",
    "https://www.facebook.com/watch/reels/?ref=bookmarks",
    "https://www.facebook.com/watch/reels?s=tab#top",
    "https://m.facebook.com/watch/reels/",
  ])("%s goes to the same-origin home", (href) => {
    const session = createEnginePageSession(allCores);
    expect(
      session.evaluate(on, new URL(href), { access, capabilities: cores }),
    ).toEqual({ kind: "redirect", url: `${new URL(href).origin}/` });
    session.stop?.();
  });
  it.each([
    "https://www.facebook.com/stillapp/reels",
    "https://www.facebook.com/stillapp/reels/",
    "https://www.facebook.com/100064860875397/reels",
    "https://www.facebook.com/reel/123",
    "https://www.facebook.com/watch/",
    "https://www.facebook.com/watch/?v=live",
    "https://www.facebook.com/watch/reels/123",
    "https://www.facebook.com/groups/watch/reels",
    "https://www.instagram.com/reel/shared/",
  ])("%s stays reachable", (href) => {
    const session = createEnginePageSession(allCores);
    expect(
      session.evaluate(on, new URL(href), { access, capabilities: cores }).kind,
    ).toBe("apply");
    session.stop?.();
  });
  it.each([
    { ...on, sites: { ...on.sites, "facebook.reels": false } },
    { ...on, services: { ...on.services, facebook: false } },
    { ...on, globalOn: false },
  ])("a committed Off leaves /watch/reels alone", (settings) => {
    const session = createEnginePageSession(allCores);
    expect(
      session.evaluate(settings, new URL("https://www.facebook.com/watch/reels/"), {
        access,
        capabilities: cores,
      }).kind,
    ).toBe("noop");
    session.stop?.();
  });
  it("an in-app push into /watch/reels is consumed and Back returns to the origin", async () => {
    const origin = "https://www.facebook.com/profile.php?id=chosen";
    const h = await host(origin);
    h.win.history.pushState({ keep: true }, "", "/watch/reels/?ref=nav");
    expect(h.entries).toEqual([origin, "https://www.facebook.com/"]);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.back()).toBe(origin);
  });
  it("an initial /watch/reels load is replaced by home exactly once", async () => {
    const h = await host("https://www.facebook.com/watch/reels/");
    expect(h.replace).toHaveBeenCalledTimes(1);
    expect(h.replace).toHaveBeenCalledWith("https://www.facebook.com/");
    expect(h.assign).not.toHaveBeenCalled();
  });
});

describe("Instagram profile Reels tab (ISS-0034): opens the profile's posts instead", () => {
  const evaluate = (href: string, settings = on) => {
    const session = createEnginePageSession(allCores);
    const decision = session.evaluate(settings, new URL(href), { access, capabilities: cores });
    session.stop?.();
    return decision;
  };
  it.each([
    ["https://www.instagram.com/someuser/reels/", "https://www.instagram.com/someuser/"],
    ["https://www.instagram.com/someuser/reels", "https://www.instagram.com/someuser/"],
    ["https://www.instagram.com/some.user_9/reels/?igsh=share#top", "https://www.instagram.com/some.user_9/"],
    ["https://instagram.com/watch/reels/", "https://instagram.com/watch/"],
    ["https://m.instagram.com/someuser/reels/", "https://m.instagram.com/someuser/"],
    ["https://www.instagram.com/explore/reels/", "https://www.instagram.com/explore/"],
  ])("%s goes to %s", (href, url) => {
    expect(evaluate(href)).toEqual({ kind: "redirect", url });
  });
  it.each([
    "https://www.instagram.com/someuser/",
    "https://www.instagram.com/someuser/tagged/",
    "https://www.instagram.com/someuser/reel/C0de_1/",
    "https://www.instagram.com/someuser/reels/C0de_1/",
    "https://www.instagram.com/someuser/reelsx/",
    "https://www.instagram.com/reelsfan/",
    "https://www.instagram.com/reels/audio/123/",
    // Instagram's other subdomains are not the web app: no profile lives there.
    "https://about.instagram.com/features/reels/",
    "https://help.instagram.com/someuser/reels/",
  ])("%s stays", (href) => {
    expect(evaluate(href).kind).toBe("apply");
  });
  it("the plural viewer keeps its own meaning for a code of \"reels\"", () => {
    expect(evaluate("https://www.instagram.com/reels/reels/")).toEqual({ kind: "redirect", url: "https://www.instagram.com/reel/reels/" });
  });
  it.each([
    { ...on, sites: { ...on.sites, "instagram.reels": false } },
    { ...on, services: { ...on.services, instagram: false } },
    { ...on, globalOn: false },
  ])("a committed Off leaves a profile's Reels tab alone", (settings) => {
    expect(evaluate("https://www.instagram.com/someuser/reels/", settings).kind).not.toBe("redirect");
  });
});

describe("Reel viewers: plural feed viewer goes home, a shared Reel opens but does not continue", () => {
  const evaluate = (href: string, settings = on) => {
    const session = createEnginePageSession(allCores);
    const decision = session.evaluate(settings, new URL(href), { access, capabilities: cores });
    session.stop?.();
    return decision;
  };
  it.each([
    ["https://www.instagram.com/reels/C0de_1/", "https://www.instagram.com/reel/C0de_1/"],
    ["https://www.instagram.com/reels/C0de_1", "https://www.instagram.com/reel/C0de_1/"],
    ["https://www.instagram.com/reels/C0de_1/?igsh=share#part", "https://www.instagram.com/reel/C0de_1/?igsh=share#part"],
  ])("Instagram plural viewer %s opens the same Reel at %s", (href, url) => {
    expect(evaluate(href)).toEqual({ kind: "redirect", url });
  });
  it.each([
    "https://www.instagram.com/reels/",
    "https://www.instagram.com/reels",
    "https://www.instagram.com/reels/?ref=nav",
  ])("bare Instagram Reels feed %s still goes home", (href) => {
    expect(evaluate(href)).toEqual({ kind: "redirect", url: "https://www.instagram.com/" });
  });
  it.each([
    "https://www.instagram.com/reel/C0de_1/",
    "https://www.instagram.com/some.user/reel/C0de_1/",
    "https://www.instagram.com/reels/audio/123/",
    "https://www.facebook.com/reel/123456",
    "https://www.facebook.com/reel/123456/?s=share",
  ])("a directly opened single Reel or audio page stays: %s", (href) => {
    expect(evaluate(href).kind).toBe("apply");
  });
  it.each([
    ["https://www.instagram.com/reel/A1/", "https://www.instagram.com/reel/B2/", "https://www.instagram.com/"],
    ["https://www.instagram.com/some.user/reel/A1/", "https://www.instagram.com/reel/B2/", "https://www.instagram.com/"],
    ["https://www.facebook.com/reel/111", "https://www.facebook.com/reel/222", "https://www.facebook.com/"],
    ["https://www.instagram.com/reels/A1/", "https://www.instagram.com/reels/B2/", "https://www.instagram.com/"],
    ["https://www.instagram.com/reel/A1/", "https://www.instagram.com/some.user/reel/B2/", "https://www.instagram.com/"],
    ["https://www.instagram.com/one.user/reel/A1/", "https://www.instagram.com/other_user/reel/B2/", "https://www.instagram.com/"],
    // One profile's own Reels modal advancing is browsing that profile's Reels: stopped too, back
    // to that profile's posts (ISS-0034).
    ["https://www.instagram.com/some.user/reel/A1/", "https://www.instagram.com/some.user/reel/B2/", "https://www.instagram.com/some.user/"],
    ["https://www.instagram.com/some.user/p/P1/", "https://www.instagram.com/some.user/reel/B2/", null],
    ["https://www.instagram.com/some.user/reel/A1/", "https://www.instagram.com/some.user/p/P2/", null],
    ["https://www.instagram.com/reel/A1/", "https://www.instagram.com/reel/A1/?igsh=x", null],
    ["https://www.facebook.com/reel/111", "https://www.facebook.com/reel/111/", null],
    ["https://www.instagram.com/p/post/", "https://www.instagram.com/reel/B2/", null],
    ["https://www.facebook.com/reel/111", "https://www.facebook.com/watch/?v=222", null],
    ["https://www.facebook.com/reel/111", "https://m.facebook.com/reel/222", null],
  ] as const)("continuation %s -> %s is %s", (from, to, expected) => {
    const session = createEnginePageSession(allCores);
    session.evaluate(on, new URL(to), { access, capabilities: cores });
    expect(session.reelContinuation?.(new URL(from), new URL(to))).toBe(expected);
    session.stop?.();
  });
  describe("Instagram's post viewer (Explore opens every tile at /p/<code>/; ISS-0038)", () => {
    /** A page whose open post viewer shows `code` as a Reel or a post (its canonical link). */
    const viewer = (code: string, kind: "reel" | "p", inDialog = true) => {
      const doc = document.implementation.createHTMLDocument("viewer");
      doc.body.innerHTML = `<main><a href="/p/Tile1/">tile</a></main>${inDialog ? '<div role="dialog">' : "<div>"}
        <article><a href="/someuser/">someuser</a><a href="/someuser/${kind}/${code}/">2d</a><a href="/p/${code}/c/1/">1d</a></article></div>`;
      return doc;
    };
    const step = (from: string, to: string, doc: Document, settings = on) => {
      const session = createEnginePageSession(allCores);
      session.evaluate(settings, new URL(to), { access, capabilities: cores });
      const result = session.reelContinuation?.(new URL(from), new URL(to), (code) => instagramViewerShowsReel(doc, code)) ?? null;
      session.stop?.();
      return result;
    };
    it.each([
      ["https://www.instagram.com/p/A1/", "https://www.instagram.com/p/B2/"],
      ["https://www.instagram.com/p/A1/", "https://www.instagram.com/p/B2/?img_index=1"],
      ["https://www.instagram.com/p/A1/", "https://www.instagram.com/reel/B2/"],
      ["https://www.instagram.com/someuser/p/A1/", "https://www.instagram.com/someuser/p/B2/"],
    ])("moving on from a Reel it shows: %s -> %s goes Home", (from, to) => {
      expect(step(from, to, viewer("A1", "reel"))).toBe("https://www.instagram.com/");
    });
    it("the first Reel plays: a post moving on to a Reel is not stopped", () => {
      expect(step("https://www.instagram.com/p/A1/", "https://www.instagram.com/p/B2/", viewer("A1", "p"))).toBeNull();
    });
    it("only the viewer dialog counts, and only the item being left", () => {
      expect(step("https://www.instagram.com/p/A1/", "https://www.instagram.com/p/B2/", viewer("A1", "reel", false))).toBeNull();
      // The dialog shows another item's Reel link (a caption mention), not the one being left.
      expect(step("https://www.instagram.com/p/A1/", "https://www.instagram.com/p/B2/", viewer("Z9", "reel"))).toBeNull();
      // Staying on the same item (a carousel slide, a query) is not moving on.
      expect(step("https://www.instagram.com/p/A1/", "https://www.instagram.com/p/A1/?img_index=2", viewer("A1", "reel"))).toBeNull();
      // Leaving the viewer for an ordinary page is not moving on to another item.
      expect(step("https://www.instagram.com/p/A1/", "https://www.instagram.com/explore/", viewer("A1", "reel"))).toBeNull();
    });
    it.each([
      { ...on, sites: { ...on.sites, "instagram.reels": false } },
      { ...on, services: { ...on.services, instagram: false } },
      { ...on, globalOn: false },
    ])("a committed Off leaves the post viewer alone", (settings) => {
      expect(step("https://www.instagram.com/p/A1/", "https://www.instagram.com/p/B2/", viewer("A1", "reel"), settings)).toBeNull();
    });
  });
  it("continuation is only answered for the inputs just prepared", () => {
    const session = createEnginePageSession(allCores);
    session.evaluate(on, new URL("https://www.facebook.com/"), { access, capabilities: cores });
    expect(
      session.reelContinuation?.(new URL("https://www.facebook.com/reel/1"), new URL("https://www.facebook.com/reel/2")),
    ).toBeNull();
    session.stop?.();
  });

  it.each([
    ["Instagram scroll push to the plural viewer", "https://www.instagram.com/reel/A1/", "/reels/B2/", "https://www.instagram.com/"],
    ["Instagram push to another Reel", "https://www.instagram.com/reel/A1/", "/reel/B2/", "https://www.instagram.com/"],
    ["Facebook in-viewer move", "https://www.facebook.com/reel/111", "/reel/222", "https://www.facebook.com/"],
  ])("%s is stopped and Back returns to the opened Reel", async (_name, origin, next, home) => {
    const h = await host(origin);
    expect(h.replace).not.toHaveBeenCalled(); // the shared Reel itself opened
    h.win.history.pushState({}, "", next);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.entries).toEqual([origin, home]);
    expect(h.back()).toBe(origin);
  });
  it("a page-driven replaceState into another Reel is replaced by home", async () => {
    const h = await host("https://www.facebook.com/reel/111");
    h.win.history.replaceState({}, "", "/reel/222");
    expect(h.replaceState).not.toHaveBeenCalled();
    expect(h.replace).toHaveBeenCalledWith("https://www.facebook.com/");
  });
  it.each([
    ["a user-initiated navigation", { userInitiated: true }],
    ["Back/forward", { navigationType: "traverse" }],
    ["a reload", { navigationType: "reload" }],
  ] as const)("%s into another Reel is deliberate and not stopped", async (_name, options) => {
    const h = await host("https://www.facebook.com/reel/111");
    const prevent = h.navigate("https://www.facebook.com/reel/222", options);
    expect(prevent).not.toHaveBeenCalled();
    expect(h.assign).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });
  it("a page-driven Navigation API move into another Reel is prevented and sent home", async () => {
    const h = await host("https://www.instagram.com/reel/A1/");
    const prevent = h.navigate("https://www.instagram.com/reel/B2/", { userInitiated: false });
    expect(prevent).toHaveBeenCalledOnce();
    expect(h.assign).toHaveBeenCalledWith("https://www.instagram.com/");
  });
  it.each([
    ["sites.instagram.reels", "https://www.instagram.com/reel/A1/", "/reels/B2/"],
    ["services.instagram", "https://www.instagram.com/reel/A1/", "/reel/B2/"],
    ["globalOn", "https://www.instagram.com/reel/A1/", "/reels/B2/"],
    ["sites.facebook.reels", "https://www.facebook.com/reel/111", "/reel/222"],
    ["services.facebook", "https://www.facebook.com/reel/111", "/reel/222"],
    ["globalOn", "https://www.facebook.com/reel/111", "/reel/222"],
  ] as const)("Off at %s leaves %s -> %s alone", async (path, origin, next) => {
    const h = await host(origin);
    await h.writer.commit({ path, value: false, updatedAt: Date.now() });
    await h.cache.hydrate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.win.history.pushState({}, "", next);
    expect(h.push).toHaveBeenCalledOnce();
    expect(h.assign).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.win.location.href).toBe(new URL(next, origin).href);
  });
});

describe("Facebook's /reel/ feed entry (the top-menu Reels tab, ISS-0035)", () => {
  const origin = "https://www.facebook.com/groups/chosen/";
  it("an in-app push into the feed entry is consumed and Back returns to the origin", async () => {
    const h = await host(origin);
    h.win.history.pushState({}, "", "/reel/?s=tab");
    expect(h.push).not.toHaveBeenCalled();
    expect(h.entries).toEqual([origin, "https://www.facebook.com/"]);
    expect(h.back()).toBe(origin);
  });
  it.each([
    ["a page-driven move", { userInitiated: false }],
    ["a user-initiated move (the person clicked the tab)", { userInitiated: true }],
  ] as const)("%s into the feed entry through the Navigation API is prevented and sent home", async (_name, options) => {
    const h = await host(origin);
    const prevent = h.navigate("https://www.facebook.com/reel/?s=tab", options);
    expect(prevent).toHaveBeenCalledOnce();
    expect(h.assign).toHaveBeenCalledWith("https://www.facebook.com/");
  });
  it.each(["/reel/following/", "/reel/profile/", "/reel/?bss=1"])("the player's own feed link %s goes home", async (next) => {
    const h = await host("https://www.facebook.com/reel/111");
    h.win.history.pushState({}, "", next);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.entries).toEqual(["https://www.facebook.com/reel/111", "https://www.facebook.com/"]);
  });
  it("on Home, the feed entry's hand-over to its first Reel is stopped too, for a short while", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const h = await host("https://www.facebook.com/");
      // Not an anchor click: the page's own router pushes the entry, and Still is already Home.
      expect(h.navigate("https://www.facebook.com/reel/?s=tab", { userInitiated: false })).toHaveBeenCalledOnce();
      expect(h.assign).not.toHaveBeenCalled();
      expect(h.navigate("https://www.facebook.com/reel/1234567890", { navigationType: "replace", userInitiated: false })).toHaveBeenCalledOnce();
      h.win.history.replaceState({}, "", "/reel/1234567890");
      expect(h.replaceState).not.toHaveBeenCalled();
      expect(h.win.location.href).toBe("https://www.facebook.com/");
      // A Reel the person opens is deliberate, and after the window a page move is judged as usual.
      expect(h.navigate("https://www.facebook.com/reel/1234567890", { userInitiated: true })).not.toHaveBeenCalled();
      vi.setSystemTime(Date.now() + 3_000);
      h.win.history.pushState({}, "", "/reel/1234567890");
      expect(h.push).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
    it("a shared Reel opened in-app still plays", async () => {
    const h = await host(origin);
    h.win.history.pushState({}, "", "/reel/1234567890/");
    expect(h.push).toHaveBeenCalledOnce();
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.assign).not.toHaveBeenCalled();
  });
  it.each(["sites.facebook.reels", "services.facebook", "globalOn"] as const)("Off at %s leaves the feed entry alone", async (path) => {
    const h = await host(origin);
    await h.writer.commit({ path, value: false, updatedAt: Date.now() });
    await h.cache.hydrate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.win.history.pushState({}, "", "/reel/?s=tab");
    expect(h.push).toHaveBeenCalledOnce();
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.assign).not.toHaveBeenCalled();
  });
});


describe("a live change that shows hidden content asks the page to measure again (ISS-0040)", () => {
  const settle = async (h: Awaited<ReturnType<typeof host>>) => {
    await h.cache.hydrate();
    await new Promise((resolve) => setTimeout(resolve, 40));
  };
  it.each(["sites.facebook.reels", "services.facebook", "globalOn"] as const)("Off at %s fires one resize after the reveal", async (path) => {
    const h = await host("https://www.facebook.com/stillapp/photos");
    const resized = vi.fn();
    window.addEventListener("resize", resized);
    try {
      await settle(h);
      expect(resized).not.toHaveBeenCalled(); // hiding on load never asks
      await h.writer.commit({ path, value: false, updatedAt: Date.now() });
      await settle(h);
      expect(resized).toHaveBeenCalledTimes(1);
      // Turning it back on hides again, which needs no new measurement.
      await h.writer.commit({ path, value: true, updatedAt: Date.now() + 1 });
      await settle(h);
      expect(resized).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("resize", resized);
    }
  });
  it("a page Still sends elsewhere is not asked to measure", async () => {
    const h = await host("https://www.facebook.com/stillapp/photos");
    const resized = vi.fn();
    window.addEventListener("resize", resized);
    try {
      await settle(h);
      h.win.history.pushState({}, "", "/reels/");
      h.script.reapply();
      await settle(h);
      expect(resized).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("resize", resized);
    }
  });
  it("Instagram's live Off restores its profile tabs through the same layout notification", async () => {
    const h = await host("https://www.instagram.com/someuser/");
    const resized = vi.fn();
    window.addEventListener("resize", resized);
    try {
      await settle(h);
      await h.writer.commit({ path: "services.instagram", value: false, updatedAt: Date.now() });
      await settle(h);
      expect(resized).toHaveBeenCalledOnce();
      h.script.reapply();
      h.script.reapply();
      await settle(h);
      expect(resized).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("resize", resized);
    }
  });
  it("stopping before the queued layout notification keeps the page untouched", async () => {
    const h = await host("https://www.facebook.com/stillapp/photos");
    await settle(h);
    const pending: VoidFunction[] = [];
    const queue = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => { pending.push(task); });
    const resized = vi.fn();
    window.addEventListener("resize", resized);
    try {
      await h.writer.commit({ path: "services.facebook", value: false, updatedAt: Date.now() });
      await settle(h);
      expect(pending.length).toBeGreaterThan(0);
      h.script.stop();
      for (const task of pending) task();
      expect(resized).not.toHaveBeenCalled();
    } finally {
      queue.mockRestore();
      window.removeEventListener("resize", resized);
    }
  });
});
