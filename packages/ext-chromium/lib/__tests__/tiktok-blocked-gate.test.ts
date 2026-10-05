import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tiktokBlockedPageEnabled } from "../../entrypoints/tiktok-blocked/gate.js";
import { modernSettingsRuntime } from "../modern-settings-runtime.js";

// The TikTok blocked page ships behind the same release rule as the V3 popup and settings. One
// import-free gate serves both the content script and the background, and it must equal the
// maintained `atomicLocal` rule exactly, so a configured 2.x build keeps today's in-page block.

const CONFIGURED = { VITE_SUPABASE_URL: "https://project.invalid", VITE_SUPABASE_ANON_KEY: "public-anon-key" };

describe("TikTok blocked page release gate", () => {
  it("equals modernSettingsRuntime(...).atomicLocal for every build input", () => {
    const urls = [undefined, "", "   ", "https://project.invalid"];
    const keys = [undefined, "", "  ", "public-anon-key"];
    const optIns = [undefined, "", "true", "false", "TRUE", " true"];
    for (const url of urls)
      for (const key of keys)
        for (const optIn of optIns)
          expect(
            tiktokBlockedPageEnabled({
              VITE_SUPABASE_URL: url,
              VITE_SUPABASE_ANON_KEY: key,
              VITE_MODERN_SETTINGS_SYNC_ENABLED: optIn,
            }),
            JSON.stringify({ url, key, optIn }),
          ).toBe(modernSettingsRuntime(url, key, optIn).atomicLocal);
  });

  it("a configured 2.x build (Supabase set, modern sync not opted in) is off", () => {
    for (const optIn of [undefined, "", "false"])
      expect(tiktokBlockedPageEnabled({ ...CONFIGURED, VITE_MODERN_SETTINGS_SYNC_ENABLED: optIn })).toBe(false);
    expect(tiktokBlockedPageEnabled({ ...CONFIGURED, VITE_MODERN_SETTINGS_SYNC_ENABLED: "true" })).toBe(true);
    expect(tiktokBlockedPageEnabled({})).toBe(true);
  });

  it("both entrypoints read the one shared gate with the same three named, reduced inputs", () => {
    const content = readFileSync(resolve(process.cwd(), "entrypoints/content/index.ts"), "utf8");
    const background = readFileSync(resolve(process.cwd(), "entrypoints/background.ts"), "utf8");
    const inputs = [
      'VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL?.trim() ? "set" : "",',
      'VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ? "set" : "",',
      "VITE_MODERN_SETTINGS_SYNC_ENABLED: import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED,",
    ];
    expect(content).toContain('import { tiktokBlockedPageEnabled } from "../tiktok-blocked/gate.js";');
    expect(background).toContain('import { tiktokBlockedPageEnabled } from "./tiktok-blocked/gate.js";');
    for (const [name, source] of [["content", content], ["background", background]] as const) {
      expect(source.match(/tiktokBlockedPageEnabled\(/g), name).toHaveLength(1);
      expect(source, name).toContain("tiktokBlockedPageEnabled({");
      // Never the whole env object: that inlines every VITE_* value into the bundle.
      expect(source, name).not.toMatch(/tiktokBlockedPageEnabled\(\s*import\.meta\.env\s*\)/);
      for (const input of inputs) expect(source, `${name}: ${input}`).toContain(input);
    }
    expect(content).toContain("const tiktokBlockedPage = tiktokEnabled && window.top === window");
    expect(background).toContain("if (tiktokEnabled) wireTiktokBlockedPage(settingsAuthority, entitlements, platform);");
    expect(background.match(/wireTiktokBlockedPage\(/g)).toHaveLength(2); // the call and the definition
  });
});

// The real background, with browser and analytics as local ports: a configured 2.x build never
// constructs the TikTok owner or answers its messages.
vi.mock("wxt/browser", () => ({ get browser() { return globalThis.chrome; } }));
vi.mock("../analytics.js", () => ({
  storageKeyValue: () => ({}),
  createBackgroundAnalytics: () => ({
    onInstalled: vi.fn(),
    onStart: vi.fn(),
    onActivity: vi.fn(),
    listener: () => false,
    flushWhenReady: vi.fn(),
  }),
}));
vi.mock("@still/core/analytics", () => ({
  createIndexedDbKeyValue: () => ({}),
  QUIET_FLUSH_ALARM: "quiet",
  requestQuietFlush: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function background(env: Record<string, string>) {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  for (const [name, value] of Object.entries({ VITE_POSTHOG_KEY: "", VITE_POSTHOG_HOST: "", ...env }))
    vi.stubEnv(name, value);
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("No network in the gate proof");
  }));
  const messages: Array<(message: unknown, sender: unknown, reply: (value: unknown) => void) => unknown> = [];
  const tabListeners = vi.fn();
  const update = vi.fn(async () => ({}));
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  const area = { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  vi.stubGlobal("chrome", {
    storage: { local: area, session: area, onChanged: event() },
    runtime: {
      id: "still",
      getURL: (path: string) => `chrome-extension://still/${path}`,
      getManifest: () => ({ version: "3.0.0" }),
      getContexts: vi.fn(async () => []),
      onInstalled: event(),
      onMessage: { addListener: (listener: (typeof messages)[number]) => messages.push(listener) },
    },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, url: "https://www.tiktok.com/foryou" })),
      update,
      onRemoved: { addListener: tabListeners, removeListener: vi.fn() },
      onReplaced: { addListener: tabListeners, removeListener: vi.fn() },
    },
  });
  vi.stubGlobal("defineBackground", (body: () => void) => body());
  await import("../../entrypoints/background.js");
  const answered = messages.filter((listener) =>
    listener(
      { kind: "still:tiktok-blocked" },
      { id: "still", url: "https://www.tiktok.com/foryou", frameId: 0, tab: { id: 7 } },
      () => {},
    ) === true,
  ).length;
  return { answered, tabListeners, update };
}

describe("background under the TikTok release gate", () => {
  it("a configured 2.x build registers no TikTok owner and answers no TikTok message", async () => {
    const h = await background({ ...CONFIGURED, VITE_MODERN_SETTINGS_SYNC_ENABLED: "" });
    expect(h.answered).toBe(0);
    expect(h.tabListeners).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("an unconfigured build wires the owner at top level and answers", async () => {
    const h = await background({ VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" });
    expect(h.answered).toBe(1);
    expect(h.tabListeners).toHaveBeenCalled();
  });
});
