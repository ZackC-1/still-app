import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExtensionContentEntry,
  type ExtensionContentNudge,
} from "../extension-entry.js";
import type { ContentScriptHandle } from "../index.js";
import { signRuleSet } from "../../rules/signature.js";
import { writeCachedRuleSet, type ReadableArea, type WritableArea } from "../../rules/loader.js";
import type { SignedRuleSet } from "@still/shared-types";
import seed from "../../../rules/seed.json";

type Listener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;

function installChrome(): void {
  const listeners = new Set<Listener>();
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
      },
      onChanged: {
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      },
    },
  });
}

const ruleSetStorage: ReadableArea & WritableArea = {
  get: () => Promise.resolve({}),
  set: () => Promise.resolve(),
};
const startedScripts = new Set<ContentScriptHandle>();

function makeWin(href: string) {
  let current = href;
  return {
    location: { get href() { return current; }, replace: vi.fn((url: string) => { current = url; }) },
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
  };
}

afterEach(() => {
  for (const script of startedScripts) script.stop();
  startedScripts.clear();
  document.body.innerHTML = "";
  document.documentElement.className = "";
  vi.unstubAllGlobals();
});

describe("createExtensionContentEntry", () => {
  it("keeps Safari nudge creation before start, including its immediate and post-start requests", async () => {
    installChrome();
    const events: string[] = [];
    let captured: ContentScriptHandle | undefined;
    const nudge: ExtensionContentNudge = {
      attach(script) {
        events.push("attach");
        captured = script;
        events.push("initial-request");
        return { request: () => events.push("request") };
      },
    };
    const entry = createExtensionContentEntry({
      storage: ruleSetStorage,
      prod: false,
      earlyRedirect: false,
      nudge,
      onScriptCreated: (script) => { startedScripts.add(script); events.push("created"); },
      onStart: () => events.push("start"),
    });

    await entry();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(captured).toBeDefined();
    expect(events).toEqual(["created", "attach", "initial-request", "start", "request"]);
  });

  it("does not create a script or nudge after Safari invalidation during rule-set loading", async () => {
    installChrome();
    const created = vi.fn();
    const attached = vi.fn();
    let invalid = false;
    let release!: () => void;
    const readGate = new Promise<void>((resolve) => { release = resolve; });
    const delayedStorage: ReadableArea = {
      get: async () => { await readGate; return {}; },
    };
    const entry = createExtensionContentEntry({
      storage: delayedStorage,
      prod: false,
      earlyRedirect: true,
      nudge: { attach: () => (attached(), { request: vi.fn() }) },
      onScriptCreated: created,
    });

    const loading = entry({ get isInvalid() { return invalid; } });
    invalid = true;
    release();
    await loading;

    expect(created).not.toHaveBeenCalled();
    expect(attached).not.toHaveBeenCalled();
  });

  it("requests a Chromium reconcile immediately after starting without a lifecycle nudge", async () => {
    installChrome();
    const requestReconcile = vi.fn();
    const entry = createExtensionContentEntry({
      storage: ruleSetStorage,
      prod: false,
      earlyRedirect: false,
      requestReconcile,
      onScriptCreated: (script) => startedScripts.add(script),
    });

    await entry();

    expect(requestReconcile).toHaveBeenCalledTimes(1);
  });

  it("uses the JS hide path when a newer cached rule set replaces the bundled seed", async () => {
    installChrome();
    document.body.innerHTML = '<a id="endpoint" title="Shorts"></a>';
    const storage = new Map<string, unknown>();
    const cached: ReadableArea & WritableArea = {
      get: (key) => Promise.resolve(storage.has(key) ? { [key]: storage.get(key) } : {}),
      set: (items) => { for (const [key, value] of Object.entries(items)) storage.set(key, value); return Promise.resolve(); },
    };
    const bundled = seed as unknown as SignedRuleSet;
    const newer = await signRuleSet(
      { version: "9.9.9", services: bundled.services },
      "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      "still-dev-1",
    );
    await writeCachedRuleSet(cached, newer);
    const entry = createExtensionContentEntry({
      storage: cached,
      prod: false,
      earlyRedirect: false,
      win: makeWin("https://www.youtube.com/") as never,
      doc: document,
      onScriptCreated: (script) => startedScripts.add(script),
    });

    await entry();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((document.querySelector("#endpoint") as HTMLElement).style.display).toBe("none");
  });

  it("leaves bundled hide selectors to the packaged manifest CSS fast path", async () => {
    installChrome();
    document.body.innerHTML = '<a id="endpoint" title="Shorts"></a>';
    const entry = createExtensionContentEntry({
      storage: ruleSetStorage,
      prod: false,
      earlyRedirect: false,
      win: makeWin("https://www.youtube.com/") as never,
      doc: document,
      onScriptCreated: (script) => startedScripts.add(script),
    });

    await entry();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((document.querySelector("#endpoint") as HTMLElement).style.display).toBe("");
  });

  it("starts the early redirect before the rule-set read and avoids a second replace", async () => {
    installChrome();
    let release!: () => void;
    const readGate = new Promise<void>((resolve) => { release = resolve; });
    const delayedStorage: ReadableArea = {
      get: async () => { await readGate; return {}; },
    };
    const win = makeWin("https://www.youtube.com/shorts/abc");
    const entry = createExtensionContentEntry({
      storage: delayedStorage,
      prod: false,
      earlyRedirect: true,
      win: win as never,
      doc: document,
      onScriptCreated: (script) => startedScripts.add(script),
    });

    const loading = entry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(win.location.replace).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc");
    release();
    await loading;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(win.location.replace).toHaveBeenCalledTimes(1);
  });
});
