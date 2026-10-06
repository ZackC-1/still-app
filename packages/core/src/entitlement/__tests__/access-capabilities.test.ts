import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FEATURE_REGISTRY, PAID_TIER_ENABLED, type BenefitId, type SettingsV2 } from "@still/shared-types";
import {
  ACCESS_HOSTS,
  IMPLEMENTED_PRO_FEATURES,
  accessCapabilities,
  accessCapabilitiesForTest,
  initialAccessSnapshot,
  isBenefitEffective,
  packagedAccessContext,
  type AccessHost,
  type AccessPlatform,
} from "../access-policy.js";
import parity from "../../../../shared-types/fixtures/access-capabilities.json";

// The dormancy gate (owner decision 6): a Still Pro feature is a host capability only while the
// paid tier is on and the host implements it. No module mock: this runs against the shipped flag.

const PRO = FEATURE_REGISTRY.filter((feature) => feature.tier === "pro").map((feature) => feature.id);
const FREE: BenefitId[] = [...FEATURE_REGISTRY.filter((feature) => feature.tier === "free").map((feature) => feature.id), "tiktok.all"];
const sorted = (set: ReadonlySet<BenefitId>) => [...set].sort();
const everyPro: Record<AccessHost, readonly BenefitId[]> = { chromium: PRO, firefox: PRO, safari: PRO };

describe("accessCapabilities dormancy gate", () => {
  it("ships with the paid tier off, so the packaged context holds exactly the free features", () => {
    expect(PAID_TIER_ENABLED).toBe(false);
    const context = packagedAccessContext();
    expect(context.paidMode).toBe(false);
    expect(sorted(context.supported)).toEqual(parity.paidOffSupported);
    for (const host of ACCESS_HOSTS) expect(sorted(packagedAccessContext(host).supported)).toEqual(parity.paidOffSupported);
  });

  it("with paid off, never lists a Pro feature, even when every host implements all 12", () => {
    for (const host of [undefined, ...ACCESS_HOSTS]) {
      const supported = accessCapabilitiesForTest({ paidMode: false, host }, everyPro);
      expect(sorted(supported), String(host)).toEqual(parity.paidOffSupported);
      for (const id of PRO) expect(supported.has(id), `${host}:${id}`).toBe(false);
    }
  });

  it("with paid off, every Pro feature resolves unsupported and no saved On is effective", () => {
    const access = initialAccessSnapshot();
    const settings = { globalOn: true, services: { youtube: true, instagram: true, facebook: true, tiktok: true },
      sites: Object.fromEntries(FEATURE_REGISTRY.map((feature) => [feature.id, true])) } as unknown as SettingsV2;
    for (const id of PRO) {
      expect(access.states[id], id).toBe("unsupported");
      expect(isBenefitEffective(settings, id, access.states[id], packagedAccessContext().supported.has(id)), id).toBe(false);
    }
    for (const id of FREE) expect(access.states[id], id).toBe("free");
  });

  it("with paid on, adds only the features implemented on that host (all hosts when the host is unknown)", () => {
    const table = { chromium: ["youtube.comments", "instagram.threads"], firefox: ["youtube.comments"], safari: [] } as const;
    const on = (host?: AccessHost) => sorted(accessCapabilitiesForTest({ paidMode: true, host }, table));
    expect(on("chromium")).toEqual([...FREE, "youtube.comments", "instagram.threads"].sort());
    expect(on("firefox")).toEqual([...FREE, "youtube.comments"].sort());
    expect(on("safari")).toEqual([...FREE].sort());
    expect(on()).toEqual([...FREE].sort());
    expect(sorted(accessCapabilitiesForTest({ paidMode: true }, everyPro))).toEqual([...FREE, ...PRO].sort());
    // A table entry that is not a Pro feature can never add or remove anything.
    const odd = { chromium: ["youtube.shorts", "tiktok.all"], firefox: [], safari: [] } as const;
    expect(sorted(accessCapabilitiesForTest({ paidMode: true, host: "chromium" }, odd))).toEqual([...FREE].sort());
  });

  it("the packaged implementation table lists only Pro features", () => {
    for (const host of ACCESS_HOSTS) for (const id of IMPLEMENTED_PRO_FEATURES[host]) expect(PRO).toContain(id);
  });

  it("pins every host's implemented Still Pro list exactly (adding or dropping one is a deliberate edit here)", () => {
    expect(IMPLEMENTED_PRO_FEATURES).toEqual({
      chromium: [
        "instagram.explore", "instagram.stories", "instagram.suggested", "instagram.threads",
        "youtube.related", "youtube.endscreen", "youtube.comments", "youtube.livechat", "youtube.autoplay",
        "facebook.stories", "facebook.videos", "facebook.sponsored",
      ],
      firefox: [
        "instagram.explore", "instagram.stories", "instagram.suggested", "instagram.threads",
        "youtube.related", "youtube.endscreen", "youtube.comments", "youtube.livechat", "youtube.autoplay",
        "facebook.stories", "facebook.videos", "facebook.sponsored",
      ],
      safari: [
        "instagram.explore", "instagram.stories", "instagram.suggested", "instagram.threads",
        "facebook.stories", "facebook.videos",
      ],
    });
  });

  it("with paid on, a host-aware caller gets its whole host list; the host-less default only the intersection", () => {
    const pro = (host?: AccessHost) => sorted(accessCapabilitiesForTest({ paidMode: true, host }, IMPLEMENTED_PRO_FEATURES))
      .filter((id) => PRO.includes(id as (typeof PRO)[number]));
    for (const host of ACCESS_HOSTS) expect(pro(host), host).toEqual([...IMPLEMENTED_PRO_FEATURES[host]].sort());
    // The host-less set is what a caller that forgot its host would offer: Chromium and Firefox
    // would lose the YouTube extras, Autoplay and Desktop sidebar ads.
    expect(pro()).toEqual([...IMPLEMENTED_PRO_FEATURES.safari].sort());
    for (const id of ["youtube.comments", "youtube.autoplay", "facebook.sponsored"] as const) {
      expect(pro("chromium"), id).toContain(id);
      expect(pro(), id).not.toContain(id);
    }
  });
});

describe("runtime platform seam (Firefox for Android)", () => {
  const DESKTOP_ONLY = ["youtube.autoplay", "facebook.sponsored"];
  const on = (host: AccessHost | undefined, platform?: AccessPlatform) =>
    sorted(accessCapabilitiesForTest({ paidMode: true, host, platform }, IMPLEMENTED_PRO_FEATURES));

  it("absent or desktop keeps the host's whole list (the long-standing behaviour)", () => {
    for (const host of [undefined, ...ACCESS_HOSTS]) {
      expect(on(host, "desktop"), String(host)).toEqual(on(host));
      expect(sorted(packagedAccessContext(host, "desktop").supported)).toEqual(sorted(packagedAccessContext(host).supported));
    }
    for (const id of DESKTOP_ONLY) expect(on("firefox"), id).toContain(id);
  });

  it("android drops exactly the desktop-only controls, and nothing else", () => {
    const android = on("firefox", "android");
    for (const id of DESKTOP_ONLY) expect(android, id).not.toContain(id);
    expect(android).toEqual(on("firefox").filter((id) => !DESKTOP_ONLY.includes(id)));
    // The mobile-layout controls Firefox for Android still offers (their selectors stay E0-gated).
    expect(android).toEqual(expect.arrayContaining(["youtube.comments", "instagram.explore", "facebook.videos"]));
    expect(on("chromium", "android")).toEqual(android);
  });

  it("unknown is treated like a phone: a control that might do nothing is held back", () => {
    expect(on("firefox", "unknown")).toEqual(on("firefox", "android"));
  });

  it("never changes Safari's list, which claims no desktop-only control", () => {
    for (const platform of ["android", "desktop", "unknown"] as const) expect(on("safari", platform), platform).toEqual(on("safari"));
  });

  it("paid off, the platform changes nothing: exactly the free features on every host", () => {
    for (const host of [undefined, ...ACCESS_HOSTS])
      for (const platform of [undefined, "android", "desktop", "unknown"] as const) {
        expect(sorted(packagedAccessContext(host, platform).supported), `${host}:${platform}`).toEqual(parity.paidOffSupported);
        expect(sorted(accessCapabilities({ paidMode: PAID_TIER_ENABLED, host, platform }))).toEqual(parity.paidOffSupported);
        expect(sorted(accessCapabilitiesForTest({ paidMode: false, host, platform }, everyPro))).toEqual(parity.paidOffSupported);
      }
  });
});

describe("test-only seams never reach shipped code", () => {
  // Every non-test source file in the packages that build shipped artifacts.
  const roots = ["packages/core/src", "packages/core/scripts", "packages/ext-chromium", "packages/ext-safari", "packages/app-webview/src", "packages/shared-types/src"]
    .map((root) => resolve(import.meta.dirname, "../../../../..", root));
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name.startsWith(".") || name === "dist" || name === ".output") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|svelte|mjs|js)$/.test(name) && !/\.(test|spec)\.ts$|test-fixtures|\.fixtures\.ts$/.test(name)) files.push(path);
    }
  };
  for (const root of roots) walk(root);
  const repo = resolve(import.meta.dirname, "../../../../..");

  it.each(["accessCapabilitiesForTest", "createFormat2PageSessionForTest"])("only the defining module mentions %s", (seam) => {
    expect(files.length).toBeGreaterThan(100);
    const users = files.filter((file) => readFileSync(file, "utf8").includes(seam)).map((file) => relative(repo, file));
    expect(users).toEqual([seam === "accessCapabilitiesForTest" ? "packages/core/src/entitlement/access-policy.ts" : "packages/core/src/rules/engine.ts"]);
  });
});
