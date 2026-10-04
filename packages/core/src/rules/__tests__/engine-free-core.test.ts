import { describe, it, expect } from "vitest";
import type { ServiceId } from "@still/shared-types";
import { FEATURE_REGISTRY, TIKTOK_ALIAS } from "@still/shared-types";
import { migrateSettingsV2 } from "../../storage/settings-v2.js";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { createEnginePageSession } from "../engine.js";
import {
  ruleSet as format2Rules,
  on as format2On,
  access,
  capabilities,
  url as format2Url,
} from "./format2-fixtures.js";
import { evaluate, applyDom, applyRemovals, isServiceEnabledGlobally } from "../engine.js";
import { ruleSet, settings } from "./engine-test-fixtures.js";

function modernProjection() {
  const migrated = migrateSettingsV2(null, { kind: "proven-fresh" });
  if (migrated.status !== "ready")
    throw new Error("Fresh settings unavailable");
  return { ...migrated.settings, pauses: [] };
}

describe("packaged format1 committed free-core choices", () => {
  const routes: Record<ServiceId, string> = {
    youtube: "https://www.youtube.com/shorts/abc",
    instagram: "https://www.instagram.com/reel/abc/",
    facebook: "https://www.facebook.com/reel/123",
    tiktok: "https://www.tiktok.com/foryou",
  };

  it.each(FEATURE_REGISTRY.filter((feature) => feature.tier === "free"))(
    "$id Off holds navigation and DOM effects with global/service On",
    (feature) => {
      const on = modernProjection();
      const url = new URL(routes[feature.service]);
      expect(evaluate(ruleSet, on, url).kind).toBe(
        feature.service === "youtube" ? "redirect" : "placeholder",
      );
      const off = { ...on, sites: { ...on.sites, [feature.id]: false } };
      expect(isServiceEnabledGlobally(off, feature.service)).toBe(false);
      expect(evaluate(ruleSet, off, url)).toEqual({ kind: "noop" });
      document.body.innerHTML =
        '<ytd-reel-shelf-renderer id="short"></ytd-reel-shelf-renderer><a id="reel" href="/reel/123">Reel</a><div id="ordinary">Keep</div>';
      const before = document.body.innerHTML;
      expect(applyDom(ruleSet, off, url, document)).toEqual({
        hidden: 0,
        removed: 0,
      });
      expect(applyRemovals(ruleSet, off, url, document)).toEqual({
        hidden: 0,
        removed: 0,
      });
      expect(document.body.innerHTML).toBe(before);
    },
  );

  it("does not grant core effects from optional or unknown flags, or override global/service Off", () => {
    const on = modernProjection();
    const optionalOnly = {
      ...on,
      sites: {
        ...on.sites,
        "youtube.shorts": false,
        "youtube.comments": true,
        "unknown.core": true,
      },
    };
    expect(evaluate(ruleSet, optionalOnly, new URL(routes.youtube))).toEqual({
      kind: "noop",
    });
    for (const off of [
      { ...on, globalOn: false },
      { ...on, services: { ...on.services, youtube: false } },
    ]) {
      expect(isServiceEnabledGlobally(off, "youtube")).toBe(false);
      expect(evaluate(ruleSet, off, new URL(routes.youtube))).toEqual({
        kind: "noop",
      });
    }
  });

  it.each(
    [
      undefined,
      null,
      false,
      "true",
      [],
      {},
      { "youtube.shorts": "true" },
      { "youtube.shorts": 1 },
    ].map((sites) => ({ sites })),
  )(
    "holds schema2 effects when sites is missing or malformed ($sites)",
    ({ sites }) => {
      const projection = { ...settings(), schemaVersion: 2, sites };
      expect(isServiceEnabledGlobally(projection, "youtube")).toBe(false);
      expect(evaluate(ruleSet, projection, new URL(routes.youtube))).toEqual({
        kind: "noop",
      });
    },
  );

  it("leaves schema-absent legacy choices and TikTok's service alias unchanged", () => {
    const legacy = { ...settings(), sites: { "youtube.shorts": false } };
    expect(isServiceEnabledGlobally(legacy, "youtube")).toBe(true);
    expect(evaluate(ruleSet, legacy, new URL(routes.youtube))).toEqual({
      kind: "redirect",
      url: "https://www.youtube.com/watch?v=abc",
    });
    const modern = modernProjection();
    expect(TIKTOK_ALIAS.field).toBe("services.tiktok");
    expect(evaluate(ruleSet, modern, new URL(routes.tiktok))).toEqual({
      kind: "placeholder",
      blocked: true,
    });
    expect(
      evaluate(
        ruleSet,
        { ...modern, services: { ...modern.services, tiktok: false } },
        new URL(routes.tiktok),
      ),
    ).toEqual({ kind: "noop" });
  });

  it("recomputes a page session from actual writer/cache On to Off to On projections", async () => {
    const adapter = new InMemoryStorageAdapter();
    const writer = new AtomicSettingsWriter(adapter);
    await writer.initializeFresh(async () => true);
    const cache = new SettingsCache(
      {
        get: () => adapter.get(),
        set: (record) => adapter.set(record),
        subscribe: (listener) => adapter.subscribe(listener),
        commitIntent: (intent) => writer.commit(intent),
      },
      { now: () => 42 },
    );
    await cache.hydrate();
    const session = createEnginePageSession(ruleSet);
    const url = new URL(routes.youtube);
    expect(session.evaluate(cache.current(), url)).toEqual({
      kind: "redirect",
      url: "https://www.youtube.com/watch?v=abc",
    });
    await cache.setFeature("youtube.shorts", false);
    expect(session.evaluate(cache.current(), url)).toEqual({ kind: "noop" });
    expect(session.activeServiceId()).toBeNull();
    document.body.innerHTML =
      '<ytd-reel-shelf-renderer id="short"></ytd-reel-shelf-renderer><div id="ordinary">Keep</div>';
    const home = new URL("https://www.youtube.com/");
    expect(session.applyRemovals(cache.current(), home, document)).toEqual({
      hidden: 0,
      removed: 0,
    });
    expect(document.getElementById("short")).not.toBeNull();
    await cache.setFeature("youtube.shorts", true);
    expect(session.applyRemovals(cache.current(), home, document).removed).toBe(
      1,
    );
    expect(document.getElementById("short")).toBeNull();
    expect(document.getElementById("ordinary")).not.toBeNull();
    expect(session.evaluate(cache.current(), url).kind).toBe("redirect");
    expect((await adapter.get())?.atomic).toMatchObject({
      sequence: 2,
      ownership: "never-linked",
    });
  });

  it("keeps a supported format2 optional feature effective when its core choice is Off", () => {
    const session = createEnginePageSession(format2Rules);
    document.body.innerHTML =
      '<div id="short" class="shorts">Short</div><div id="comments" class="comments">Comments</div>';
    const settings = {
      ...format2On,
      sites: { ...format2On.sites, "youtube.shorts": false },
    };
    try {
      expect(
        session.evaluate(settings, format2Url, { access, capabilities }),
      ).toEqual({ kind: "apply" });
      session.applyDom(settings, format2Url, document, {
        access,
        capabilities,
      });
      expect(
        getComputedStyle(document.getElementById("short")!).display,
      ).not.toBe("none");
      expect(
        getComputedStyle(document.getElementById("comments")!).display,
      ).toBe("none");
    } finally {
      session.stop?.();
    }
  });
});
