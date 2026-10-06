import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ServiceId } from "@still/shared-types";
import { createShippingContentEntry, type ShippingContentLane } from "../extension-entry.js";
import type { ContentScriptHandle } from "../index.js";
import { createFormat2EntryHost } from "./format2-entry-host.js";
import { createModernShippingContentEntry } from "../modern-shipping-entry.js";
import { PACKAGED_RULE_SET_V2 } from "../../rules/packaged.js";

// Firefox and Safari have no DNR redirect, so a direct /shorts/<id> load is redirected by the
// content script. Every storage read below is held and released in rounds: a round resolves all
// reads pending at that moment. The legacy entry redirects after one round; the shipping entry
// must too, whichever lane it picks, so the Shorts player window never widens.

const scripts: ContentScriptHandle[] = [];
// Both shipping entries must keep the same early timing (the V3 entry generalizes the trigger).
const FACTORIES = [
  ["shipping entry", createShippingContentEntry],
  ["modern entry", createModernShippingContentEntry],
] as const;
let factory: (typeof FACTORIES)[number][1] = createShippingContentEntry;
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

async function rounds(options: { services: ReadonlySet<ServiceId>; legacySettings?: boolean; earlyRedirect?: boolean; offPath?: string }) {
  const h = await createFormat2EntryHost(PACKAGED_RULE_SET_V2 as never, "youtube.html", SHORTS, scripts);
  if (options.offPath)
    await h.authority.commitIntent({ path: options.offPath as "globalOn", value: false, updatedAt: Date.now() });
  if (options.legacySettings)
    h.values["still:settings"] = { settings: { ...DEFAULT_SETTINGS, updatedAt: 5 }, syncMetadata: null };
  const area = local();
  const original = area.get.bind(area);
  let queue: Array<() => void> = [];
  const reads: string[] = [];
  vi.spyOn(area, "get").mockImplementation((key: string) => {
    reads.push(key);
    return new Promise((resolve) => queue.push(() => resolve(original(key))));
  });
  const lanes: ShippingContentLane[] = [];
  const created = vi.fn();
  const loading = factory({
    storage: area,
    prod: false,
    earlyRedirect: options.earlyRedirect ?? true,
    format2Services: options.services,
    win: h.win,
    doc: document,
    onLane: (lane) => lanes.push(lane),
    onScriptCreated: (script) => { created(); scripts.push(script); },
  })();
  const readsAtCall = [...reads];
  const releaseRound = async () => {
    await tick();
    const round = queue;
    queue = [];
    for (const resolve of round) resolve();
    await tick();
    await tick();
  };
  /** Release rounds until the redirect happens; returns how many rounds it took. */
  const roundsUntilRedirect = async (max = 6) => {
    for (let round = 1; round <= max; round++) {
      await releaseRound();
      if (h.replace.mock.calls.length) return round;
    }
    return Infinity;
  };
  const finish = async () => {
    for (let round = 0; round < 8; round++) await releaseRound();
    await loading;
  };
  return { h, lanes, created, readsAtCall, roundsUntilRedirect, finish };
}

describe.each(FACTORIES)("%s: early Shorts redirect timing (Firefox/Safari)", (_name, entry) => {
  beforeEach(() => {
    factory = entry;
  });

  it("held page: the legacy early redirect starts synchronously, before any extra await", async () => {
    const r = await rounds({ services: new Set() });
    expect(r.readsAtCall).toContain("still:settings"); // started inside the synchronous call
    expect(r.lanes).toEqual([{ kind: "legacy", reason: "service-held" }]);
    expect(await r.roundsUntilRedirect()).toBe(1);
    expect(r.h.replace).toHaveBeenCalledWith(WATCH);
    await r.finish();
    expect(r.h.replace).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["format-2 lane (schema-2 settings)", false, "format2"],
    ["legacy fallback (schema-1 settings)", true, "legacy"],
  ] as const)("activated page, %s: redirect after one storage round, like legacy", async (_name, legacySettings, kind) => {
    const r = await rounds({ services: ACTIVE, legacySettings });
    expect(await r.roundsUntilRedirect()).toBe(1);
    expect(r.h.replace).toHaveBeenCalledWith(WATCH);
    await r.finish();
    expect(r.lanes[0]!.kind).toBe(kind);
    expect(r.created).toHaveBeenCalled();
    expect(r.h.replace).toHaveBeenCalledTimes(1); // the hydrated script never replaces again
  });

  it("activated page: lane and rule-set reads share one round before the content script starts", async () => {
    const r = await rounds({ services: ACTIVE, earlyRedirect: false });
    expect(r.created).not.toHaveBeenCalled();
    await r.roundsUntilRedirect(1); // releases exactly one round
    // Legacy: the rule-set read (one round), then the script exists. The shipping entry's lane
    // read and the prefetched rule-set read resolve in that same round.
    expect(r.created).toHaveBeenCalledTimes(1);
    expect(r.lanes).toEqual([{ kind: "format2" }]);
    await r.finish();
  });

  it("the Chromium content script itself redirects only after its own hydration round", async () => {
    const r = await rounds({ services: ACTIVE, earlyRedirect: false });
    expect(await r.roundsUntilRedirect()).toBe(2);
    await r.finish();
    expect(r.h.replace).toHaveBeenCalledTimes(1);
  });

  it.each(["sites.youtube.shorts", "services.youtube", "globalOn"])(
    "format-2 lane: saved Off at %s never redirects, early or late",
    async (offPath) => {
      const r = await rounds({ services: ACTIVE, offPath });
      expect(await r.roundsUntilRedirect()).toBe(Infinity);
      await r.finish();
      expect(r.lanes).toEqual([{ kind: "format2" }]);
      expect(r.h.replace).not.toHaveBeenCalled();
      expect(r.h.win.location.href).toBe(SHORTS);
    },
  );

  it("format-2 lane: an SPA navigation away during the read cancels the early redirect", async () => {
    const r = await rounds({ services: ACTIVE });
    r.h.setHref("https://www.youtube.com/watch?v=chosen");
    await r.finish();
    expect(r.h.replace).not.toHaveBeenCalled();
  });

  it("Chromium (no content early redirect) leaves the hard navigation to DNR until hydration", async () => {
    const r = await rounds({ services: ACTIVE, earlyRedirect: false });
    await r.roundsUntilRedirect(1);
    expect(r.h.replace).not.toHaveBeenCalled();
    await r.finish();
    expect(r.h.replace).toHaveBeenCalledTimes(1);
  });
});
