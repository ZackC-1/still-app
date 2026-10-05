import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ServiceId, type SettingsV2, type StillSettings } from "@still/shared-types";
import { admitPackagedRuleSetV2, PACKAGED_RULE_SET_V2 } from "../../../core/src/rules/packaged.js";
import { planNavigationDnr, type NavigationDnrRule } from "../../../core/src/rules/navigation-dnr.js";
import { migrateSettingsV2 } from "@still/core/storage";
import { createNavigationDnrSync, type NavigationDnrApi } from "../navigation-dnr.js";
import { KEY, start, retainedDnrRecord } from "./settings-bootstrap.fixtures.js";

const STATIC = "youtube-shorts-redirect";
const packaged = admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2);
const SHIPPING = new Set<ServiceId>(["youtube", "instagram", "facebook"]);

const fresh = (() => {
  const result = migrateSettingsV2(null, { kind: "proven-fresh" });
  if (result.status !== "ready") throw new Error("fresh settings did not initialize");
  return result.settings;
})();
const withSite = (settings: SettingsV2, feature: string, value: boolean): SettingsV2 =>
  ({ ...settings, sites: { ...settings.sites, [feature]: value } }) as SettingsV2;
type AnySettings = StillSettings | SettingsV2;
const expected = (settings: AnySettings | null) =>
  planNavigationDnr({ packaged, shippingServices: SHIPPING, settings }).rules;
const domains = (rules: readonly { condition: { requestDomains: readonly string[] } }[]) =>
  [...new Set(rules.flatMap((rule) => rule.condition.requestDomains))].sort();

/**
 * Chrome's declarativeNetRequest for these calls: an update validates the whole request before
 * applying any of it (a duplicate id rejects and changes nothing), removals of unknown ids are
 * ignored, and static rulesets toggle by id.
 */
function chromeDnr() {
  let session = new Map<number, NavigationDnrRule>();
  const enabled = new Set([STATIC]);
  const calls: string[] = [];
  let failNext: Error | null = null;
  let hold: Promise<void> | null = null;
  const api: NavigationDnrApi & { getSessionRules(): Promise<NavigationDnrRule[]> } = {
    async getSessionRules() {
      return [...session.values()].map((rule) => structuredClone(rule));
    },
    async updateSessionRules({ removeRuleIds, addRules }) {
      calls.push(`updateSessionRules(-${removeRuleIds.length},+${addRules.length})`);
      if (hold) {
        calls.push("held");
        await hold;
      }
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      const next = new Map(session);
      for (const id of removeRuleIds) next.delete(id);
      for (const rule of addRules) {
        if (next.has(rule.id)) throw new Error(`Rule with id ${rule.id} already exists`);
        next.set(rule.id, structuredClone(rule));
      }
      session = next;
    },
    async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] }) {
      calls.push(`updateEnabledRulesets(${enableRulesetIds.length ? "enable" : "disable"})`);
      for (const id of disableRulesetIds) enabled.delete(id);
      for (const id of enableRulesetIds) enabled.add(id);
    },
  };
  return {
    api,
    calls,
    rules: () => [...session.values()],
    staticOn: () => enabled.has(STATIC),
    failNextUpdate: (error: Error) => { failNext = error; },
    /** A rule another part of the extension installed in the same session-rule space. */
    addForeign: (rule: NavigationDnrRule) => { session.set(rule.id, structuredClone(rule)); },
    holdReads() {
      let release!: () => void;
      hold = new Promise((resolve) => { release = resolve; });
      return () => { hold = null; release(); };
    },
  };
}

function harness(initial: AnySettings | null) {
  const dnr = chromeDnr();
  const state = { settings: initial, unreadable: false, cached: DEFAULT_SETTINGS as StillSettings };
  const controller = createNavigationDnrSync({
    api: dnr.api,
    staticRulesetId: STATIC,
    readSettings: async () => {
      if (state.unreadable) throw new Error("storage unavailable");
      // The authority's record type is the legacy shape; schema-2 records arrive through it too.
      return state.settings as StillSettings | null;
    },
    cachedSettings: () => state.cached,
    packaged,
    shippingServices: SHIPPING,
  });
  return { dnr, state, sync: controller.sync, retire: controller.retire };
}

describe("navigation DNR sync (format-2 builds)", () => {
  it("installs the compiled free rules and retires the static Shorts ruleset", async () => {
    const h = harness(fresh);
    await h.sync();
    expect(h.dnr.rules()).toEqual(expected(fresh));
    expect(domains(h.dnr.rules())).toEqual(["facebook.com", "instagram.com", "youtube.com"]);
    expect(h.dnr.staticOn()).toBe(false);
    // Off first: the static ruleset is disabled before any session rule changes.
    expect(h.dnr.calls[0]).toBe("updateEnabledRulesets(disable)");
  });

  it.each([
    ["instagram.reels", "instagram.com"],
    ["facebook.reels", "facebook.com"],
    ["youtube.shorts", "youtube.com"],
  ])("toggling %s Off leaves no stale rule, and On restores it", async (feature, domain) => {
    const h = harness(fresh);
    await h.sync();
    h.state.settings = withSite(fresh, feature, false);
    await h.sync();
    expect(domains(h.dnr.rules())).not.toContain(domain);
    expect(h.dnr.rules()).toEqual(expected(h.state.settings));
    expect(h.dnr.staticOn()).toBe(false);
    h.state.settings = fresh;
    await h.sync();
    expect(h.dnr.rules()).toEqual(expected(fresh));
  });

  it("master switch Off removes every rule; On restores them", async () => {
    const h = harness(fresh);
    await h.sync();
    h.state.settings = { ...fresh, globalOn: false } as SettingsV2;
    await h.sync();
    expect(h.dnr.rules()).toEqual([]);
    expect(h.dnr.staticOn()).toBe(false);
    h.state.settings = fresh;
    await h.sync();
    expect(h.dnr.rules()).toEqual(expected(fresh));
  });

  it("an unknown (absent) choice compiles to no rule", async () => {
    const sites = { ...fresh.sites } as Record<string, boolean>;
    delete sites["instagram.reels"];
    const h = harness({ ...fresh, sites } as SettingsV2);
    await h.sync();
    expect(domains(h.dnr.rules())).toEqual(["facebook.com", "youtube.com"]);
  });

  it("calls made while a pass runs get a later pass that reads the newest settings", async () => {
    const h = harness(fresh);
    const release = h.dnr.holdReads();
    const first = h.sync();
    await vi.waitFor(() => expect(h.dnr.calls).toContain("held"));
    // The first pass already read all-on settings; Instagram goes Off while it is held.
    h.state.settings = withSite(fresh, "instagram.reels", false);
    const second = h.sync();
    const third = h.sync();
    expect(third).toBe(second); // not yet started: shared
    release();
    await Promise.all([first, second]);
    expect(domains(h.dnr.rules())).toEqual(["facebook.com", "youtube.com"]);
  });

  it("retire withholds a choice's rules from every pass until released", async () => {
    const h = harness(fresh);
    await h.sync();
    const { release, failure } = await h.retire("sites.instagram.reels");
    expect(failure).toBeNull();
    // Removed while the saved choice is still On, and an unrelated pass does not bring them back.
    expect(domains(h.dnr.rules())).toEqual(["facebook.com", "youtube.com"]);
    await h.sync();
    expect(domains(h.dnr.rules())).toEqual(["facebook.com", "youtube.com"]);
    // Released with the choice never saved Off (say the save failed): the rules return.
    release();
    await vi.waitFor(() => expect(h.dnr.rules()).toEqual(expected(fresh)));
    // The master switch retires every rule; a service switch retires only that service's.
    const { release: all } = await h.retire("globalOn");
    expect(h.dnr.rules()).toEqual([]);
    all();
    const { release: youtube } = await h.retire("services.youtube");
    expect(domains(h.dnr.rules())).toEqual(["facebook.com", "instagram.com"]);
    youtube();
    await vi.waitFor(() => expect(h.dnr.rules()).toEqual(expected(fresh)));
  });

  it("removes only its own rule ids: another session rule survives every sync", async () => {
    const h = harness(fresh);
    const foreign = {
      id: 9001, priority: 1, action: { type: "allow" as const },
      condition: { regexFilter: "^https://example\\.invalid/$", isUrlFilterCaseSensitive: true as const, requestDomains: ["example.invalid"], resourceTypes: ["main_frame"] as const },
    } satisfies NavigationDnrRule;
    h.dnr.addForeign(foreign);
    await h.sync();
    h.state.settings = { ...fresh, globalOn: false } as SettingsV2;
    await h.sync();
    expect(h.dnr.rules()).toEqual([foreign]);
    h.state.settings = fresh;
    await h.sync();
    expect(h.dnr.rules()).toEqual([foreign, ...expected(fresh)]);
  });

  it("a failed update while retiring keeps the redirect out until the Off is committed", async () => {
    const h = harness(fresh);
    await h.sync();
    h.dnr.failNextUpdate(new Error("quota"));
    const { release, failure } = await h.retire("sites.youtube.shorts");
    expect(failure).toEqual(new Error("quota"));
    // The failed pass cleared every owned rule; the hold keeps YouTube's out of later passes.
    expect(h.dnr.rules()).toEqual([]);
    await h.sync(); // e.g. a storage notification before the Off lands
    expect(domains(h.dnr.rules())).toEqual(["facebook.com", "instagram.com"]);
    // The Off commits, then the hold is released: the redirect stays gone.
    h.state.settings = withSite(fresh, "youtube.shorts", false);
    release();
    await h.sync();
    expect(domains(h.dnr.rules())).toEqual(["facebook.com", "instagram.com"]);
  });

  it("schema-1 settings keep the legacy lane: no session rules, static ruleset gated as before", async () => {
    const h = harness(fresh);
    await h.sync();
    h.state.settings = DEFAULT_SETTINGS;
    await h.sync();
    expect(h.dnr.rules()).toEqual([]);
    expect(h.dnr.staticOn()).toBe(true);
    h.state.settings = { ...DEFAULT_SETTINGS, services: { ...DEFAULT_SETTINGS.services, youtube: false } };
    await h.sync();
    expect(h.dnr.staticOn()).toBe(false);
    expect(h.dnr.rules()).toEqual([]);
  });

  it("unreadable settings clear the session rules and gate the static ruleset on the cache", async () => {
    const h = harness(fresh);
    await h.sync();
    h.state.unreadable = true;
    h.state.cached = { ...DEFAULT_SETTINGS, globalOn: false };
    await h.sync();
    expect(h.dnr.rules()).toEqual([]);
    expect(h.dnr.staticOn()).toBe(false);
  });

  it("a failed rule update clears the session rules and reports the failure", async () => {
    const h = harness(fresh);
    await h.sync();
    h.state.settings = withSite(fresh, "youtube.shorts", false);
    h.dnr.failNextUpdate(new Error("quota"));
    await expect(h.sync()).rejects.toThrow("quota");
    expect(h.dnr.rules()).toEqual([]);
    // The next pass recovers fully.
    await h.sync();
    expect(h.dnr.rules()).toEqual(expected(h.state.settings));
  });
});

// The real background, cache and settings router; only the browser's DNR and storage are doubled.
describe("background navigation DNR wiring", () => {
  const fullDnr = () => {
    const dnr = chromeDnr();
    const updateEnabledRulesets = vi.fn(dnr.api.updateEnabledRulesets);
    return { dnr, updateEnabledRulesets, sessionRules: { getSessionRules: dnr.api.getSessionRules, updateSessionRules: dnr.api.updateSessionRules } };
  };
  const shortsRules = (rules: readonly NavigationDnrRule[]) => rules.filter((rule) => rule.condition.requestDomains.includes("youtube.com"));

  it("a format-2 build mirrors saved choices, and a settings reply waits for the rules", async () => {
    // Retained modern settings: YouTube On, Instagram and Facebook services Off.
    const retained = retainedDnrRecord(true, true);
    const d = fullDnr();
    const h = await start({ [KEY]: retained }, d.updateEnabledRulesets, "true", { sessionRules: d.sessionRules });
    expect(domains(d.dnr.rules())).toEqual(["youtube.com"]);
    expect(d.dnr.staticOn()).toBe(false);
    for (const [index, value] of [false, true].entries()) {
      const reply = await h.message({ kind: "still:settings-intent", path: "sites.youtube.shorts", value, updatedAt: 60 + index });
      expect(reply).toMatchObject({ status: "committed" });
      // No settle: the reply itself means the rules already match the saved choice.
      expect(shortsRules(d.dnr.rules()).length > 0, `youtube.shorts=${value}`).toBe(value);
      expect(d.dnr.staticOn()).toBe(false);
    }
    // Saved choices are never rewritten by the rule sync.
    expect(h.store[KEY]).toMatchObject({ settings: { services: { instagram: false, facebook: false } } });
  });

  it("an Off is saved only after its redirect rules are gone", async () => {
    const d = fullDnr();
    const h = await start({ [KEY]: retainedDnrRecord(true, true) }, d.updateEnabledRulesets, "true", { sessionRules: d.sessionRules });
    expect(domains(d.dnr.rules())).toEqual(["youtube.com"]);
    const write = h.gateWrite(KEY);
    const reply = h.message({ kind: "still:settings-intent", path: "sites.youtube.shorts", value: false, updatedAt: 70 });
    await write.started;
    // The saved Off is about to become readable by pages: no Shorts redirect may remain.
    expect(d.dnr.rules()).toEqual([]);
    write.release();
    expect(await reply).toMatchObject({ status: "committed" });
    expect(d.dnr.rules()).toEqual([]);
  });

  it("a failed rule update while retiring still keeps the redirect out until the Off is saved", async () => {
    const d = fullDnr();
    const h = await start({ [KEY]: retainedDnrRecord(true, true) }, d.updateEnabledRulesets, "true", { sessionRules: d.sessionRules });
    expect(domains(d.dnr.rules())).toEqual(["youtube.com"]);
    d.dnr.failNextUpdate(new Error("quota"));
    const write = h.gateWrite(KEY);
    const reply = h.message({ kind: "still:settings-intent", path: "sites.youtube.shorts", value: false, updatedAt: 71 });
    await write.started;
    expect(d.dnr.rules()).toEqual([]);
    // Any pass that runs while the Off is still being written keeps Shorts out (the hold).
    await h.settle();
    expect(d.dnr.rules()).toEqual([]);
    write.release();
    expect(await reply).toMatchObject({ status: "committed" });
    await h.settle();
    expect(d.dnr.rules()).toEqual([]);
  });

  it("an external settings write (another context or sync) updates the rules", async () => {
    const d = fullDnr();
    const h = await start({ [KEY]: retainedDnrRecord(true, true) }, d.updateEnabledRulesets, "true", { sessionRules: d.sessionRules });
    expect(domains(d.dnr.rules())).toEqual(["youtube.com"]);
    const record = structuredClone(h.store[KEY]) as ReturnType<typeof retainedDnrRecord>;
    // A peer context commits master Off through storage, bypassing this worker's router.
    await (globalThis.chrome.storage.local.set as (items: Record<string, unknown>) => Promise<void>)({
      [KEY]: { ...record, settings: { ...record.settings, globalOn: false }, atomic: { ...record.atomic, sequence: record.atomic.sequence + 1 } },
    });
    await h.settle();
    expect(d.dnr.rules()).toEqual([]);
  });

  it("a configured (legacy) build keeps today's static gate and never touches session rules", async () => {
    const d = fullDnr();
    const getSessionRules = vi.fn(d.sessionRules.getSessionRules);
    const updateSessionRules = vi.fn(d.sessionRules.updateSessionRules);
    await start(
      { [KEY]: { settings: { ...DEFAULT_SETTINGS, updatedAt: 5 }, syncMetadata: null } },
      d.updateEnabledRulesets,
      "false",
      {
        sessionRules: { getSessionRules, updateSessionRules },
        env: { VITE_SUPABASE_URL: "https://example.supabase.co", VITE_SUPABASE_ANON_KEY: "public-test-key" },
      },
    );
    expect(d.updateEnabledRulesets).toHaveBeenCalled();
    for (const args of d.updateEnabledRulesets.mock.calls) expect(args).toEqual([{ enableRulesetIds: [STATIC] }]);
    expect(d.dnr.staticOn()).toBe(true);
    expect(getSessionRules).not.toHaveBeenCalled();
    expect(updateSessionRules).not.toHaveBeenCalled();
  });
});
