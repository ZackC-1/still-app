import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionContentEntry } from "../extension-entry.js";
import type { ContentScriptHandle } from "../index.js";
import { ruleSet } from "../../rules/__tests__/format2-fixtures.js";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
const scripts: ContentScriptHandle[] = [];
afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});
async function entry(href: string, enabled = true) {
  const listeners = new Set<(...args: unknown[]) => void>();
  const store = new InMemoryStorageAdapter({
    ...DEFAULT_SETTINGS,
    updatedAt: 1,
  });
  const writer = new AtomicSettingsWriter(store);
  await writer.initialize("never-linked");
  await writer.commit({
    path: "sites.youtube.shorts",
    value: enabled,
    updatedAt: 2,
  });
  const record = (await store.get())!;
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async () => ({ "still:settings": structuredClone(record) }),
        set: vi.fn(),
      },
      onChanged: {
        addListener: (fn: (...args: unknown[]) => void) => listeners.add(fn),
        removeListener: (fn: (...args: unknown[]) => void) =>
          listeners.delete(fn),
      },
    },
  });
  let current = href;
  const replace = vi.fn((url: string) => {
    current = url;
  });
  const win = {
    location: {
      get href() {
        return current;
      },
      replace,
    },
    history: {
      pushState: vi.fn((_data, _unused, url) => {
        if (url) current = new URL(url, current).href;
      }),
      replaceState: vi.fn((_data, _unused, url) => {
        if (url) current = new URL(url, current).href;
      }),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    MutationObserver: window.MutationObserver,
  };
  document.body.innerHTML =
    '<div id="target" class="shorts">Short</div><div id="normal">Normal</div>';
  await createExtensionContentEntry({
    storage: { get: async () => ({}) },
    prod: false,
    earlyRedirect: true,
    bundledRuleSetV2: ruleSet,
    win,
    doc: document,
    onScriptCreated: (script) => scripts.push(script),
  })();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { win, replace, record, listeners };
}
describe("actual maintained extension entry internal format2 lane", () => {
  it("a committed feature Off is not overridden by the legacy service-only redirect", async () => {
    const h = await entry(
      "https://www.youtube.com/shorts/abc?list=chosen",
      false,
    );
    expect(h.replace).not.toHaveBeenCalled();
    expect(
      getComputedStyle(document.getElementById("target")!).display,
    ).not.toBe("none");
  });
  it("consumes real modern cache and applies only its scoped stylesheet through the shared entry", async () => {
    await entry("https://www.youtube.com/");
    expect(getComputedStyle(document.getElementById("target")!).display).toBe(
      "none",
    );
    expect(document.documentElement.classList.contains("still-active")).toBe(
      false,
    );
    expect(document.getElementById("normal")).not.toBeNull();
    for (const script of scripts) script.stop();
    expect(
      getComputedStyle(document.getElementById("target")!).display,
    ).not.toBe("none");
  });
});
