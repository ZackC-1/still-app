import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import { DEFAULT_SETTINGS, type SignedRuleSetV2 } from "@still/shared-types";
import { createExtensionContentEntry } from "../extension-entry.js";
import type { ContentScriptHandle, StillWindow } from "../index.js";
import { ChromeStorageAdapter } from "../../storage/chrome-adapter.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function createFormat2EntryHost(
  bundle: SignedRuleSetV2,
  file: string,
  href: string,
  scripts: ContentScriptHandle[],
) {
  const values: Record<string, unknown> = {};
  const listeners = new Set<
    (changes: Record<string, { newValue: unknown }>, area: string) => void
  >();
  let delay: Promise<void> | null = null;
  let nextReadFailure = false;
  vi.stubGlobal("chrome", {
    runtime: { getURL: () => "chrome-extension://fixture/" },
    storage: {
      local: {
        async get(key: string) {
          if (nextReadFailure && key === "still:settings") {
            nextReadFailure = false;
            throw new Error("Read unavailable");
          }
          const snapshot = structuredClone(values);
          if (delay && key === "still:settings") {
            const pending = delay;
            delay = null;
            await pending;
          }
          return snapshot;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(values, structuredClone(items));
          for (const listener of listeners)
            listener(
              Object.fromEntries(
                Object.entries(items).map(([key, newValue]) => [
                  key,
                  { newValue },
                ]),
              ),
              "local",
            );
        },
      },
      onChanged: {
        addListener: (
          fn: (
            changes: Record<string, { newValue: unknown }>,
            area: string,
          ) => void,
        ) => listeners.add(fn),
        removeListener: (
          fn: (
            changes: Record<string, { newValue: unknown }>,
            area: string,
          ) => void,
        ) => listeners.delete(fn),
      },
    },
  });
  const authority = new ChromeStorageAdapter({ authority: true });
  await authority.set({
    settings: { ...DEFAULT_SETTINGS, updatedAt: 1 },
    syncMetadata: null,
  });
  await authority.initializeAtomic("never-linked");
  let current = href;
  const replace = vi.fn((url: string) => {
    current = url;
  });
  const win: StillWindow = {
    location: {
      get href() {
        return current;
      },
      replace,
    },
    history: {
      pushState: (_data, _unused, url) => {
        if (url) current = new URL(url, current).href;
      },
      replaceState: (_data, _unused, url) => {
        if (url) current = new URL(url, current).href;
      },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    MutationObserver: window.MutationObserver,
  };
  const html = readFileSync(resolve("../../tests/fixtures", file), "utf8");
  document.body.innerHTML = new DOMParser().parseFromString(
    html,
    "text/html",
  ).body.innerHTML;
  return {
    authority,
    values,
    listeners,
    win,
    replace,
    setHref: (href: string) => {
      current = href;
    },
    hold: (pending: Promise<void>) => {
      delay = pending;
    },
    failRead: () => {
      nextReadFailure = true;
    },
    async start(modern = true) {
      await createExtensionContentEntry({
        storage: { get: async () => ({}) },
        bundledRuleSetV2: modern ? bundle : undefined,
        prod: false,
        earlyRedirect: true,
        win,
        doc: document,
        onScriptCreated: (script) => scripts.push(script),
      })();
      await tick();
      return scripts[scripts.length - 1]!;
    },
  };
}
