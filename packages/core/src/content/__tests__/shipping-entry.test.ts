import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ServiceId } from "@still/shared-types";
import {
  createShippingContentEntry,
  FORMAT2_SHIPPING_SERVICES,
  type ShippingContentEntryDeps,
  type ShippingContentLane,
} from "../extension-entry.js";
import type { ContentScriptHandle } from "../index.js";
import { createFormat2EntryHost } from "./format2-entry-host.js";
import { PACKAGED_RULE_SET_V2 } from "../../rules/packaged.js";

const scripts: ContentScriptHandle[] = [];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const ACTIVE: ReadonlySet<ServiceId> = new Set(["youtube", "instagram", "facebook", "tiktok"]);
type Host = Awaited<ReturnType<typeof createFormat2EntryHost>>;

afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

const hidden = (id: string) => {
  for (let at: Element | null = document.getElementById(id); at; at = at.parentElement)
    if (getComputedStyle(at).display === "none") return true;
  return false;
};
const rootClasses = () => [...document.documentElement.classList];
const local = () =>
  (globalThis as unknown as { chrome: { storage: { local: ShippingContentEntryDeps["storage"] } } }).chrome
    .storage.local;

function host(file: string, href: string) {
  // The bundle argument only feeds the helper's own start(); these tests use the shipping entry.
  return createFormat2EntryHost(PACKAGED_RULE_SET_V2 as never, file, href, scripts);
}

async function start(h: Host, overrides: Partial<ShippingContentEntryDeps> = {}) {
  const lanes: ShippingContentLane[] = [];
  const storage = local();
  const reads: string[] = [];
  await createShippingContentEntry({
    storage: { get: (key) => (reads.push(key), storage.get(key)) },
    prod: false,
    earlyRedirect: true,
    format2Services: ACTIVE,
    win: h.win,
    doc: document,
    onScriptCreated: (script) => scripts.push(script),
    onLane: (lane) => lanes.push(lane),
    ...overrides,
  })();
  await tick();
  await tick();
  return { lanes, reads, script: scripts[scripts.length - 1]! };
}

/** A stored settings record exactly as a legacy (schema 1) writer leaves it. */
function legacySettings(h: Host, settings: object = { ...DEFAULT_SETTINGS, updatedAt: 5 }) {
  h.values["still:settings"] = { settings, syncMetadata: null };
}

describe("shipping content entry lane selection", () => {
  it("holds every shipping service on the legacy seed engine today, with no extra settings read", async () => {
    expect([...FORMAT2_SHIPPING_SERVICES]).toEqual([]);
    const h = await host("youtube.html", "https://www.youtube.com/");
    const { lanes, reads } = await start(h, { format2Services: undefined });
    expect(lanes).toEqual([{ kind: "legacy", reason: "service-held" }]);
    expect(reads).not.toContain("still:settings");
    expect(rootClasses()).toEqual(expect.arrayContaining(["still-active", "still-service-youtube"]));
    expect(rootClasses().some((name) => name.startsWith("still-feature-"))).toBe(false);
  });

  it("runs the packaged format-2 lane for an activated service with committed schema-2 settings", async () => {
    const h = await host("youtube.html", "https://www.youtube.com/");
    const shelf = document.getElementById("shelf")!;
    const keep = [...document.querySelectorAll<HTMLElement>('[id^="keep-"]')].map((node) => [node, node.outerHTML] as const);
    const { lanes } = await start(h);
    expect(lanes).toEqual([{ kind: "format2" }]);
    for (const id of ["shelf", "rich-shorts-section", "subs-shorts-shelf", "shorts-guide", "shorts-mini-guide"])
      expect(hidden(id), id).toBe(true);
    // Hidden by the scoped stylesheet: the renderer-owned node stays attached, nothing is removed.
    expect(document.getElementById("shelf")).toBe(shelf);
    for (const [node, html] of keep) {
      expect(hidden(node.id), node.id).toBe(false);
      expect(node.outerHTML, node.id).toBe(html);
    }
    // The legacy manifest-CSS roots are never raised, so the two engines never stack.
    expect(rootClasses().some((name) => name === "still-active" || name.startsWith("still-service-"))).toBe(false);
    expect(document.body.querySelector("#still-placeholder")).toBeNull();
  });

  it("Off hides nothing and stop removes every owned effect", async () => {
    const h = await host("instagram-home.html", "https://www.instagram.com/");
    const { lanes, script } = await start(h);
    expect(lanes).toEqual([{ kind: "format2" }]);
    expect(hidden("reel-post")).toBe(true);
    const saved = await h.authority.commitIntent({ path: "sites.instagram.reels", value: false, updatedAt: Date.now() });
    expect(hidden("reel-post")).toBe(false);
    expect(rootClasses()).toEqual([]);
    await h.authority.commitIntent({ path: "sites.instagram.reels", value: true, updatedAt: Date.now() });
    expect(hidden("reel-post")).toBe(true);
    script.stop();
    expect(hidden("reel-post")).toBe(false);
    expect(rootClasses()).toEqual([]);
    expect(document.head.querySelector("style")).toBeNull();
    expect(saved.settings).toMatchObject({ sites: { "instagram.reels": false } });
  });

  it("recycled and late nodes follow the stylesheet without a sweep, and SPA navigation keeps the lane", async () => {
    const h = await host("youtube-mobile.html", "https://m.youtube.com/");
    await start(h);
    const card = document.getElementById("mobile-shorts-card")!;
    expect(hidden(card.id)).toBe(true);
    card.querySelector("ytm-media-item")?.classList.remove("big-shorts-singleton");
    card.querySelector("a")!.setAttribute("href", "/watch?v=ordinary");
    expect(hidden(card.id)).toBe(false);
    card.querySelector("a")!.setAttribute("href", "/shorts/recycled");
    expect(hidden(card.id)).toBe(true);
    h.win.history.pushState(null, "", "/results?search_query=example");
    const late = document.createElement("ytm-reel-shelf-renderer");
    late.id = "late-shelf";
    document.querySelector("ytm-app")!.append(late);
    expect(hidden("late-shelf")).toBe(true);
    expect(hidden("keep-mobile-video")).toBe(false);
  });

  it("an initial Shorts URL in the format-2 lane is normalized to the watch page once", async () => {
    const h = await host("youtube.html", "https://www.youtube.com/shorts/abc123?t=4");
    const { lanes } = await start(h);
    expect(lanes).toEqual([{ kind: "format2" }]);
    expect(h.replace).toHaveBeenCalledTimes(1);
    expect(h.replace).toHaveBeenCalledWith("https://www.youtube.com/watch?t=4&v=abc123");
  });

  it("a legacy schema-1 settings projection keeps the legacy engine, so its blocking still applies", async () => {
    const h = await host("youtube.html", "https://www.youtube.com/");
    legacySettings(h);
    const { lanes } = await start(h);
    expect(lanes).toEqual([{ kind: "legacy", reason: "settings-not-schema2" }]);
    expect(rootClasses()).toEqual(expect.arrayContaining(["still-active", "still-service-youtube"]));
    expect(document.getElementById("shelf")).toBeNull(); // the legacy remove surface ran
    expect(hidden("keep-video")).toBe(false);
  });

  it("a saved legacy Off on the legacy fallback still hides nothing", async () => {
    const h = await host("youtube.html", "https://www.youtube.com/");
    legacySettings(h, { ...DEFAULT_SETTINGS, globalOn: false, updatedAt: 5 });
    const { lanes } = await start(h);
    expect(lanes).toEqual([{ kind: "legacy", reason: "settings-not-schema2" }]);
    expect(rootClasses()).toEqual([]);
    expect(document.getElementById("shelf")).not.toBeNull();
    expect(hidden("shelf")).toBe(false);
  });

  it.each([
    ["absent", (h: Host) => { delete h.values["still:settings"]; }, "settings-absent"],
    ["malformed", (h: Host) => { h.values["still:settings"] = "not settings"; }, "settings-not-schema2"],
  ] as const)("%s settings fall back to the legacy engine", async (_name, arrange, reason) => {
    const h = await host("youtube.html", "https://www.youtube.com/");
    arrange(h);
    const { lanes } = await start(h);
    expect(lanes).toEqual([{ kind: "legacy", reason }]);
  });

  it("a failing settings read falls back to the legacy engine", async () => {
    const h = await host("youtube.html", "https://www.youtube.com/");
    const { lanes } = await start(h, {
      storage: { get: async (key) => { if (key === "still:settings") throw new Error("unavailable"); return {}; } },
    });
    expect(lanes).toEqual([{ kind: "legacy", reason: "settings-unreadable" }]);
  });

  it("an invalid packaged set falls back to the legacy seed engine and its existing behaviour", async () => {
    const h = await host("youtube.html", "https://www.youtube.com/");
    const broken = structuredClone(PACKAGED_RULE_SET_V2) as { services: Record<string, unknown> };
    delete broken.services.instagram;
    const { lanes } = await start(h, { packagedRuleSetV2: broken });
    expect(lanes).toEqual([{ kind: "legacy", reason: "packaged-invalid" }]);
    expect(rootClasses()).toEqual(expect.arrayContaining(["still-active", "still-service-youtube"]));
    expect(document.getElementById("shelf")).toBeNull();
    expect(rootClasses().some((name) => name.startsWith("still-feature-"))).toBe(false);
  });

  it("TikTok keeps the account-free legacy site block until a trusted blocked-screen port exists", async () => {
    const h = await host("tiktok.html", "https://www.tiktok.com/foryou");
    const { lanes } = await start(h);
    expect(lanes).toEqual([{ kind: "legacy", reason: "tiktok-port-absent" }]);
    expect(document.body.textContent).toContain("This site is blocked.");
    expect(document.getElementById("tiktok-feed")).toBeNull();
  });

  it("TikTok with a trusted port runs the format-2 alias and never rewrites the page", async () => {
    const h = await host("tiktok.html", "https://www.tiktok.com/foryou");
    const port = vi.fn((_target: URL) => true);
    const { lanes } = await start(h, { handleBlockedNavigation: port });
    expect(lanes).toEqual([{ kind: "format2" }]);
    expect(port).toHaveBeenCalled();
    expect(document.getElementById("tiktok-feed")).not.toBeNull();
    expect(document.getElementById("still-placeholder")).toBeNull();
  });

  it("a page outside the four services never selects format-2", async () => {
    const h = await host("youtube.html", "https://www.youtube.com.example.com/");
    const { lanes, reads } = await start(h);
    expect(lanes).toEqual([{ kind: "legacy", reason: "no-service" }]);
    expect(reads).not.toContain("still:settings");
  });

  it("invalidation during the settings read creates no consumer", async () => {
    const h = await host("youtube.html", "https://www.youtube.com/");
    const created = vi.fn();
    let invalid = false;
    const storage = local();
    const run = createShippingContentEntry({
      storage: { get: async (key) => { const value = await storage.get(key); invalid = true; return value; } },
      prod: false,
      earlyRedirect: true,
      format2Services: ACTIVE,
      win: h.win,
      doc: document,
      isInvalid: () => invalid,
      onScriptCreated: created,
    })();
    await run;
    await tick();
    expect(created).not.toHaveBeenCalled();
    expect(rootClasses()).toEqual([]);
  });
});
