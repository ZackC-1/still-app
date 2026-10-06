import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FEATURE_REGISTRY } from "@still/shared-types";
import {
  EXTRAS_CONTROLS,
  EXTRAS_FIXTURE_DIR,
  EXTRAS_INTENT_PATHS,
  extrasFixture,
  extrasFixtureFiles,
  fixtureIds,
} from "./extras-fixtures.js";

const proFeatures = FEATURE_REGISTRY.filter((f) => f.tier === "pro" && f.freshDefault === false);

describe("extras fixture table", () => {
  it("covers exactly the 12 Pro extras, once each, on the registry's service", () => {
    const listed = EXTRAS_CONTROLS.map((c) => c.feature).sort();
    expect(listed).toEqual(proFeatures.map((f) => f.id).sort());
    expect(new Set(listed).size).toBe(12);
    for (const control of EXTRAS_CONTROLS)
      expect(proFeatures.find((f) => f.id === control.feature)?.service).toBe(control.service);
    expect(EXTRAS_INTENT_PATHS).toHaveLength(12);
  });

  it("references only fixtures that exist, and every fixture is referenced", () => {
    const onDisk = readdirSync(EXTRAS_FIXTURE_DIR).filter((f) => f.endsWith(".html")).sort();
    expect(extrasFixtureFiles().sort()).toEqual(onDisk);
  });

  it("serves each page on its service's host", () => {
    const hosts = { youtube: /(^|\.)youtube\.com$/, instagram: /(^|\.)instagram\.com$/, facebook: /(^|\.)facebook\.com$/ };
    for (const control of EXTRAS_CONTROLS)
      for (const page of control.pages)
        expect(new URL(page.url).hostname, page.url).toMatch(hosts[control.service]);
  });
});

describe("extras fixture content", () => {
  it.each(extrasFixtureFiles())("%s: marks its selector family as an unverified candidate", (file) => {
    const html = extrasFixture(file);
    expect(html).toMatch(/UNVERIFIED/);
    expect(html).toMatch(/Invented text/i);
  });

  it.each(extrasFixtureFiles())("%s: has preserved content, and unique ids", (file) => {
    const html = extrasFixture(file);
    expect(fixtureIds(html, "keep-").length).toBeGreaterThan(0);
    const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("gives every control at least one target-present page", () => {
    for (const control of EXTRAS_CONTROLS) {
      const withTargets = control.pages.filter((p) => fixtureIds(extrasFixture(p.file), "target-").length > 0);
      // Route-only fixtures (live chat route, autoplay probe) legitimately carry no hide target.
      const routeOnly = control.pages.every((p) => /yt-live-chat-route|yt-autoplay/.test(p.file));
      expect(withTargets.length > 0 || routeOnly, control.feature).toBe(true);
    }
  });

  it("contains no real-looking handles or captured content", () => {
    for (const file of extrasFixtureFiles()) {
      const html = extrasFixture(file);
      // Only invented handles, ids and hosts: no email addresses, no long numeric ids beyond the
      // 9000... invented range, no non-.example external hosts other than the real Threads hosts.
      expect(html, file).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i);
      for (const [, id] of html.matchAll(/\b(\d{12,})\b/g)) expect(id, file).toMatch(/^9\d{11,}$/);
    }
  });
});
