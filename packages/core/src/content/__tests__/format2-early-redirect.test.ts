import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceId } from "@still/shared-types";
import { createShippingContentEntry, type ShippingContentLane } from "../extension-entry.js";
import type { ContentScriptHandle } from "../index.js";
import { createFormat2EntryHost } from "./format2-entry-host.js";
import { PACKAGED_RULE_SET_V2 } from "../../rules/packaged.js";

// Firefox and Safari have no DNR redirect, so a direct /shorts/<id> load is redirected by the
// content script. These cases pin the format-2 lane's timing against the legacy lane: both
// redirect before the rule-set read and before the content script hydrates; format-2 waits for
// exactly one more local read (the lane's own settings read) first.

const scripts: ContentScriptHandle[] = [];
const SHORTS = "https://www.youtube.com/shorts/abc123";
const WATCH = "https://www.youtube.com/watch?v=abc123";
const ACTIVE: ReadonlySet<ServiceId> = new Set(["youtube", "instagram", "facebook"]);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

type Area = { get(key: string): Promise<Record<string, unknown>> };
const local = () => (globalThis as unknown as { chrome: { storage: { local: Area } } }).chrome.storage.local;

/** Rule-set reads (the format-2 or legacy cache key) are held until released. */
function heldRuleReads(order: string[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const area: Area = {
    get: async (key) => {
      order.push(`entry:${key}`);
      if (key.startsWith("still:ruleset")) await gate;
      return local().get(key);
    },
  };
  return { area, release };
}

async function run(format2: boolean, earlyRedirect = true) {
  const h = await createFormat2EntryHost(PACKAGED_RULE_SET_V2 as never, "youtube.html", SHORTS, scripts);
  const order: string[] = [];
  const area = local();
  const original = area.get.bind(area);
  vi.spyOn(area, "get").mockImplementation(async (key: string) => {
    order.push(`cache:${key}`);
    return original(key);
  });
  h.replace.mockImplementation(() => { order.push("replace"); });
  const { area: storage, release } = heldRuleReads(order);
  const lanes: ShippingContentLane[] = [];
  const created = vi.fn();
  const loading = createShippingContentEntry({
    storage,
    prod: false,
    earlyRedirect,
    format2Services: format2 ? ACTIVE : new Set(),
    win: h.win,
    doc: document,
    onLane: (lane) => lanes.push(lane),
    onScriptCreated: (script) => { created(); scripts.push(script); },
  })();
  return { h, order, release, loading, lanes, created };
}

describe("early Shorts redirect timing (Firefox/Safari)", () => {
  it.each([
    ["legacy", false],
    ["format-2", true],
  ] as const)("%s lane redirects before the rule-set read and before the content script exists", async (_lane, format2) => {
    const r = await run(format2);
    await tick();
    await tick();
    expect(r.lanes[0]!.kind).toBe(format2 ? "format2" : "legacy");
    expect(r.h.replace).toHaveBeenCalledWith(WATCH);
    expect(r.created).not.toHaveBeenCalled(); // still held on the rule-set read
    r.release();
    await r.loading;
    await tick();
    expect(r.created).toHaveBeenCalled();
    expect(r.h.replace).toHaveBeenCalledTimes(1); // the hydrated script never replaces again
  });

  it("format-2 waits for exactly one extra local settings read compared with legacy", async () => {
    const legacy = await run(false);
    await tick();
    await tick();
    const legacyBefore = legacy.order.slice(0, legacy.order.indexOf("replace"));
    legacy.release();
    await legacy.loading;
    for (const script of scripts.splice(0)) script.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    const modern = await run(true);
    await tick();
    await tick();
    const modernBefore = modern.order.slice(0, modern.order.indexOf("replace"));
    modern.release();
    await modern.loading;

    // "cache:" marks every underlying storage-area read; "entry:" marks which of them came
    // through the entry's own area (the lane read). Legacy: one settings read, by its cache.
    // Format-2: the lane read first, then one cache hydrate for the early decision.
    const areaReads = (order: string[]) => order.filter((step) => step === "cache:still:settings");
    expect(areaReads(legacyBefore)).toHaveLength(1);
    expect(areaReads(modernBefore)).toHaveLength(2);
    expect(modernBefore.filter((step) => step.endsWith("still:settings"))).toEqual([
      "entry:still:settings", "cache:still:settings", "cache:still:settings",
    ]);
    expect(legacyBefore.some((step) => step.startsWith("entry:still:settings"))).toBe(false);
  });

  it.each(["sites.youtube.shorts", "services.youtube", "globalOn"] as const)(
    "format-2 lane: saved Off at %s never redirects, early or late",
    async (path) => {
      const h = await createFormat2EntryHost(PACKAGED_RULE_SET_V2 as never, "youtube.html", SHORTS, scripts);
      await h.authority.commitIntent({ path, value: false, updatedAt: Date.now() });
      await createShippingContentEntry({
        storage: local(),
        prod: false,
        earlyRedirect: true,
        format2Services: ACTIVE,
        win: h.win,
        doc: document,
        onScriptCreated: (script) => scripts.push(script),
      })();
      await tick();
      await tick();
      expect(h.replace).not.toHaveBeenCalled();
      expect(h.win.location.href).toBe(SHORTS);
    },
  );

  it("format-2 lane: an SPA navigation away during the settings read cancels the early redirect", async () => {
    const r = await run(true, true);
    r.h.setHref("https://www.youtube.com/watch?v=chosen");
    await tick();
    await tick();
    r.release();
    await r.loading;
    await tick();
    expect(r.h.replace).not.toHaveBeenCalled();
  });

  it("Chromium (no content early redirect) leaves the hard navigation to DNR until hydration", async () => {
    const r = await run(true, false);
    await tick();
    await tick();
    expect(r.h.replace).not.toHaveBeenCalled();
    r.release();
    await r.loading;
    await tick();
    expect(r.h.replace).toHaveBeenCalledTimes(1);
  });
});
