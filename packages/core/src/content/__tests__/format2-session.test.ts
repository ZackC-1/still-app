import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import seed from "../../../rules/seed.json";
import type { BenefitAccessSnapshot, SignedRuleSet, StillSettings } from "@still/shared-types";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { EntitlementCache, InMemoryEntitlementAdapter } from "../../entitlement/index.js";
import { createContentScript, type ContentScriptHandle } from "../index.js";
import { ruleSet, on, access, capabilities } from "../../rules/__tests__/format2-fixtures.js";

const scripts: ContentScriptHandle[] = [];
function harness() {
  const stored = { ...on, pauses: [] } as StillSettings & typeof on;
  const settings = new SettingsCache(new InMemoryStorageAdapter(null), { initial: stored });
  const adapter = new InMemoryEntitlementAdapter(false) as InMemoryEntitlementAdapter & { observeBenefits: () => Promise<BenefitAccessSnapshot> };
  adapter.observeBenefits = vi.fn(async () => access);
  const entitlement = new EntitlementCache(adapter, { access: { paidMode: true, supported: capabilities } });
  const win = { location: { href: "https://www.youtube.com/", replace: vi.fn() }, history: { pushState: vi.fn(), replaceState: vi.fn() },
    addEventListener: vi.fn(), removeEventListener: vi.fn(), MutationObserver: vi.fn(window.MutationObserver), requestAnimationFrame: vi.fn() };
  const script = createContentScript({ win, doc: document, ruleSet: seed as unknown as SignedRuleSet, ruleSetV2: ruleSet, cache: settings, entitlement, capabilities }); scripts.push(script);
  return { settings, adapter, entitlement, win, script };
}
function display(id: string) { return getComputedStyle(document.getElementById(id)!).display; }
beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = '<div id="target" class="shorts">Short</div><div id="comments" class="comments">Comment</div>'; document.documentElement.className = "site-theme"; });
afterEach(() => { for (const script of scripts.splice(0)) script.stop(); vi.restoreAllMocks(); });

describe("actual opt-in format2 content session", () => {
  it("uses the committed cache, denies pre-hydration effects, and applies feature intention/access through the real host", async () => {
    const h = harness(); h.script.reapply(); expect(display("target")).not.toBe("none");
    await h.script.start(); expect(display("target")).toBe("none");
    await h.entitlement.refreshAccess(); expect(display("comments")).toBe("none");
    expect(h.win.MutationObserver).not.toHaveBeenCalled(); expect(h.win.location.replace).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("still-active")).toBe(false);
    expect(document.getElementById("still-placeholder")).toBeNull();
  });
  it("committed access invalidation retracts effects without modifying saved settings", async () => {
    const h = harness(); await h.entitlement.refreshAccess(); await h.script.start();
    await h.entitlement.refreshAccess(); // Drain the host's startup single-flight before changing evidence.
    expect(display("comments")).toBe("none");
    const before = JSON.stringify(h.settings.current()); h.adapter.observeBenefits = vi.fn(async (): Promise<BenefitAccessSnapshot> => ({ ...access, generation: 2, states: { ...access.states, "youtube.comments": "locked" } }));
    await h.entitlement.refreshAccess(); expect(display("comments")).not.toBe("none"); expect(display("target")).toBe("none"); expect(JSON.stringify(h.settings.current())).toBe(before);
  });
  it("honours real settings cache Off transitions and restores only owned effects", async () => {
    const h = harness(); await h.script.start(); await h.entitlement.refreshAccess(); expect(display("target")).toBe("none");
    await h.settings.setGlobalOn(false); expect(display("target")).not.toBe("none"); expect(display("comments")).not.toBe("none");
    expect(document.head.querySelectorAll("style")).toHaveLength(0); expect(document.documentElement.className).toBe("site-theme");
    await h.settings.setGlobalOn(true); expect(display("target")).toBe("none");
  });
  it("settings/access updates after stop never publish; stop removes observers/styles/classes and host hooks", async () => {
    const h = harness(); await h.script.start(); await h.entitlement.refreshAccess(); h.script.stop();
    expect(display("target")).not.toBe("none"); expect(document.head.querySelectorAll("style")).toHaveLength(0); expect(document.documentElement.className).toBe("site-theme");
    h.script.reapply(); await h.entitlement.refreshAccess(); expect(display("target")).not.toBe("none");
    expect(h.win.removeEventListener).toHaveBeenCalled(); expect(h.win.MutationObserver).not.toHaveBeenCalled();
  });
  it("a stop during hydration never creates late effects", async () => {
    const h = harness(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; }); vi.spyOn(h.settings, "hydrate").mockImplementation(async () => { await pending; return h.settings.current(); });
    const starting = h.script.start(); h.script.stop(); release(); await starting;
    expect(display("target")).not.toBe("none"); expect(document.head.querySelectorAll("style")).toHaveLength(0);
  });
});
