import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExtensionContentEntry,
  type ExtensionContentEntryDeps,
} from "../extension-entry.js";
import type { ContentScriptDeps, ContentScriptHandle } from "../index.js";
import { createFormat2EntryHost } from "./format2-entry-host.js";
import { ruleSet } from "../../rules/__tests__/format2-fixtures.js";

const scripts: ContentScriptHandle[] = [];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const target = "https://www.tiktok.com/@fixture/video/123?share=chosen#details";
type Host = Awaited<ReturnType<typeof createFormat2EntryHost>>;
type BlockedPort = ContentScriptDeps["handleBlockedNavigation"];

afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

function host(href = target) {
  return createFormat2EntryHost(ruleSet, "tiktok.html", href, scripts);
}

function entry(
  h: Host,
  handleBlockedNavigation?: BlockedPort,
  modern = true,
  overrides: Partial<ExtensionContentEntryDeps> = {},
) {
  const deps = {
    storage: { get: async () => ({}) },
    bundledRuleSetV2: modern ? ruleSet : undefined,
    prod: false,
    earlyRedirect: true,
    win: h.win,
    doc: document,
    handleBlockedNavigation,
    onScriptCreated: (script: ContentScriptHandle) => scripts.push(script),
    ...overrides,
  };
  return createExtensionContentEntry(deps);
}

async function start(h: Host, port?: BlockedPort, modern = true) {
  await entry(h, port, modern)();
  await tick();
  return scripts[scripts.length - 1]!;
}

describe("TikTok blocked decision through maintained entry and committed settings", () => {
  it("delivers the original target only after successful hydration without rewriting the page or saved state", async () => {
    const h = await host();
    const feed = document.getElementById("tiktok-feed");
    const body = document.body.innerHTML;
    const saved = structuredClone(h.values);
    const port = vi.fn((_target: URL) => true);
    let release!: () => void;
    h.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const script = await start(h, port);
    script.reapply();
    expect(port).not.toHaveBeenCalled();
    release();
    await tick();
    expect(port).toHaveBeenCalled();
    expect(port.mock.calls.map(([url]) => url.href)).toEqual(
      Array(port.mock.calls.length).fill(target),
    );
    expect(document.getElementById("tiktok-feed")).toBe(feed);
    expect(document.body.innerHTML).toBe(body);
    expect(h.values).toEqual(saved);
    expect(h.win.location.href).toBe(target);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("real atomic service and master Off suppress decisions; re-enable uses the current target and preserves saved choices", async () => {
    const h = await host();
    const port = vi.fn((_target: URL) => true);
    const script = await start(h, port);
    expect(port).toHaveBeenCalled();
    for (const path of ["services.tiktok", "globalOn"] as const) {
      await h.authority.commitIntent({
        path,
        value: false,
        updatedAt: Date.now(),
      });
      const off = await h.authority.get();
      port.mockClear();
      script.reapply();
      h.win.history.pushState(null, "", "/@fixture/video/456");
      expect(h.win.location.href).toBe(
        "https://www.tiktok.com/@fixture/video/456",
      );
      expect(port).not.toHaveBeenCalled();
      expect(await h.authority.get()).toEqual(off);
      await h.authority.commitIntent({
        path,
        value: true,
        updatedAt: Date.now(),
      });
      expect(port).toHaveBeenCalled();
      expect(port.mock.calls.at(-1)![0].href).toBe(h.win.location.href);
      const on = await h.authority.get();
      script.reapply();
      expect(await h.authority.get()).toEqual(on);
    }
    expect(h.replace).not.toHaveBeenCalled();
    expect(document.getElementById("tiktok-feed")).not.toBeNull();
  });

  it("a newer real writer Off wins over a held older On hydration", async () => {
    const h = await host();
    const port = vi.fn((_target: URL) => true);
    let release!: () => void;
    h.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const script = await start(h, port);
    await h.authority.commitIntent({
      path: "services.tiktok",
      value: false,
      updatedAt: 2,
    });
    release();
    await tick();
    script.reapply();
    expect(port).not.toHaveBeenCalled();
    expect(await h.authority.get()).toMatchObject({
      settings: { services: { tiktok: false } },
    });
    expect(document.getElementById("tiktok-feed")).not.toBeNull();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it.each(["missing", "declined"] as const)(
    "%s port leaves native navigation unconsumed without inventing a fallback",
    async (kind) => {
      const h = await host();
      const port = vi.fn((_target: URL) => false);
      await start(h, kind === "missing" ? undefined : port);
      port.mockClear();
      h.win.history.pushState(null, "", "/@fixture/video/456?chosen=yes");
      expect(h.win.location.href).toBe(
        "https://www.tiktok.com/@fixture/video/456?chosen=yes",
      );
      if (kind === "declined") expect(port).toHaveBeenCalled();
      else expect(port).not.toHaveBeenCalled();
      expect(h.replace).not.toHaveBeenCalled();
      expect(document.getElementById("tiktok-feed")).not.toBeNull();
    },
  );

  it.each([
    "https://example.com/",
    "https://www.tiktok.com.example.com/",
    "https://www.youtube.com/",
  ])("does not deliver a blocked TikTok decision for %s", async (href) => {
    const h = await host(href);
    const port = vi.fn((_target: URL) => true);
    const script = await start(h, port);
    script.reapply();
    expect(port).not.toHaveBeenCalled();
    expect(h.win.location.href).toBe(href);
    expect(document.getElementById("tiktok-feed")).not.toBeNull();
  });

  it("keeps the original account-free legacy site block and never invokes the optional modern port", async () => {
    const h = await host();
    const port = vi.fn((_target: URL) => true);
    await start(h, port, false);
    expect(document.body.textContent).toContain("This site is blocked.");
    expect(document.getElementById("tiktok-feed")).toBeNull();
    expect(port).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it.each(["pending", "hydrated"] as const)(
    "stop during %s hydration restores hooks, releases listeners and fences later effects",
    async (phase) => {
      const h = await host();
      const push = h.win.history.pushState;
      const replace = h.win.history.replaceState;
      const port = vi.fn((_target: URL) => true);
      let release!: () => void;
      if (phase === "pending")
        h.hold(
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
      const script = await start(h, port);
      expect(h.listeners.size).toBeGreaterThan(0);
      script.stop();
      port.mockClear();
      if (phase === "pending") release();
      await tick();
      await h.authority.commitIntent({
        path: "globalOn",
        value: false,
        updatedAt: 2,
      });
      await h.authority.commitIntent({
        path: "globalOn",
        value: true,
        updatedAt: 3,
      });
      script.reapply();
      document.dispatchEvent(new Event("DOMContentLoaded"));
      expect(port).not.toHaveBeenCalled();
      expect(h.listeners.size).toBe(0);
      expect(h.win.history.pushState).toBe(push);
      expect(h.win.history.replaceState).toBe(replace);
      expect(document.getElementById("tiktok-feed")).not.toBeNull();
      expect(h.replace).not.toHaveBeenCalled();
    },
  );

  it("failed settings hydration holds the callback and cleans up entry listeners", async () => {
    const h = await host();
    const port = vi.fn((_target: URL) => true);
    h.failRead();
    const script = await start(h, port);
    await tick();
    script.reapply();
    expect(port).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
    expect(document.getElementById("tiktok-feed")).not.toBeNull();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("invalidation during actual rule loading prevents creating a consumer or attaching listeners", async () => {
    const h = await host();
    const port = vi.fn((_target: URL) => true);
    const created = vi.fn();
    let invalid = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loading = entry(h, port, true, {
      storage: {
        get: async () => {
          await gate;
          return {};
        },
      },
      isInvalid: () => invalid,
      onScriptCreated: created,
    })();
    invalid = true;
    release();
    await loading;
    await tick();
    expect(created).not.toHaveBeenCalled();
    expect(port).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
  });
});
