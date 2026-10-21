import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type BenefitAccessSnapshot } from "@still/shared-types";
import { createModernShippingContentEntry } from "../modern-shipping-entry.js";
import type { ContentScriptHandle, StillWindow } from "../index.js";
import { extrasFixture } from "../../rules/__tests__/extras-fixtures.js";
import { initialAccessSnapshot, packagedAccessContext } from "../../entitlement/access-policy.js";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter, type StoredSettingsRecord } from "../../storage/adapter.js";

// ISS-0107 (Mac Safari, after many popup toggles: a page loads with its Still Pro extras unapplied
// although every popup row reads On; a reload fixes it). Safari's content script reads settings
// from the app through the background, and the modern lane watches before its first read. When the
// browser-storage copy is behind the app (a toggle burst leaves it so), the page's own reconcile
// nudge mirrors the app's record into storage while the page's first read is still out; the page
// rereads and accepts that newer record. If the first read then fails (a refused, lost or late
// native reply), that failure must not undo the page: the newer accepted record wins.
// Explicit paid-on build seam, scoped to this module.
vi.mock("@still/shared-types", async (original) => ({
  ...await original<typeof import("@still/shared-types")>(), PAID_TIER_ENABLED: true,
}));

const scripts: ContentScriptHandle[] = [];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const shown = (id: string): boolean => {
  const node = document.getElementById(id);
  expect(node, id).not.toBeNull();
  for (let at = node; at; at = at.parentElement)
    if (getComputedStyle(at).display === "none") return false;
  return true;
};

afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

/** A purchased Still Pro snapshot as the Mac app answers it (only the parsed shape matters here). */
function purchased(): BenefitAccessSnapshot {
  const seed = initialAccessSnapshot(packagedAccessContext("safari", "desktop"));
  const states = Object.fromEntries(Object.entries(seed.states).map(([benefit, state]) =>
    [benefit, state === "checking" ? "purchased" : state])) as BenefitAccessSnapshot["states"];
  return { ...seed, states };
}

/** The app's records: the older one the stale browser copy still holds, and the newer saved On. */
async function appRecords() {
  const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 });
  const writer = new AtomicSettingsWriter(storage);
  const older = await writer.initialize("never-linked");
  const { intentCommitted: _c, ...newer } = await writer.commit({ path: "sites.instagram.suggested", value: true, updatedAt: 10 });
  return { older, newer: newer as StoredSettingsRecord };
}

/** A Safari content-script world: settings and access reads go to the background by message. */
function safariContentWorld(projection: StoredSettingsRecord, app: StoredSettingsRecord, firstRead: "fails" | "answers" = "fails") {
  const values: Record<string, unknown> = { "still:settings": structuredClone(projection) };
  const listeners = new Set<(changes: Record<string, { oldValue?: unknown; newValue: unknown }>, area: string) => void>();
  let failFirstRead!: () => void;
  let settingsReads = 0;
  const access = purchased();
  const sendMessage = vi.fn(async (message: { kind?: string }) => {
    if (message.kind === "still:settings-read") {
      settingsReads += 1;
      // The page's first read is the one whose native reply never comes back usable.
      if (settingsReads === 1) return new Promise((resolve) => {
        failFirstRead = () => resolve(firstRead === "fails" ? { status: "unavailable" } : { status: "ready", record: structuredClone(projection) });
      });
      return { status: "ready", record: structuredClone(app) };
    }
    if (message.kind === "observeBenefits") return { ok: true, snapshot: access };
    return undefined;
  });
  vi.stubGlobal("chrome", {
    runtime: { id: "fixture", getURL: (path = "") => `safari-web-extension://fixture/${path}`, sendMessage },
    storage: {
      local: {
        async get(key: string | string[]) {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.filter((k) => k in values).map((k) => [k, structuredClone(values[k])]));
        },
        async set(items: Record<string, unknown>) {
          for (const [key, newValue] of Object.entries(items)) {
            const oldValue = values[key];
            values[key] = structuredClone(newValue);
            for (const listener of [...listeners]) listener({ [key]: { oldValue, newValue: structuredClone(newValue) } }, "local");
          }
        },
      },
      onChanged: {
        addListener: (fn: Parameters<typeof listeners.add>[0]) => listeners.add(fn),
        removeListener: (fn: Parameters<typeof listeners.add>[0]) => listeners.delete(fn),
      },
    },
  });
  return {
    failFirstRead: () => failFirstRead(),
    settingsReads: () => settingsReads,
    setApp: (record: StoredSettingsRecord) => { app = record; },
  };
}

function pageWindow(href: string): StillWindow {
  return {
    location: { href, replace: vi.fn() },
    history: { pushState: vi.fn(), replaceState: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    MutationObserver: window.MutationObserver,
  };
}

describe("Safari content script whose first settings read fails after a newer record arrived (ISS-0107)", () => {
  // "answers" is the control: the same late first read answering with the older record it captured.
  it.each(["fails", "answers"] as const)("first read %s late: keeps running and applies the newer saved Still Pro extra", async (firstRead) => {
    const { older, newer } = await appRecords();
    const world = safariContentWorld(older, newer, firstRead);
    document.body.innerHTML = new DOMParser().parseFromString(extrasFixture("ig-suggested.html"), "text/html").body.innerHTML;

    await createModernShippingContentEntry({ host: "safari", storage: chrome.storage.local, prod: false,
      earlyRedirect: true, win: pageWindow("https://www.instagram.com/"), doc: document,
      onScriptCreated: (script) => scripts.push(script) })();
    await tick();
    expect(world.settingsReads()).toBe(1); // the first read is still out

    // The page's reconcile nudge: the background mirrors the app's newer record into storage.
    await chrome.storage.local.set({ "still:settings": structuredClone(newer) });
    await tick(); await tick();
    expect(world.settingsReads()).toBe(2); // the storage signal made the page reread the app

    world.failFirstRead();
    for (let i = 0; i < 5; i++) await tick();

    expect(shown("target-sidebar-suggestions"), "Suggested accounts hidden").toBe(false);
    for (const id of [...document.querySelectorAll('[id^="keep-"]')].map((node) => node.id))
      expect(shown(id), `${id} kept`).toBe(true);

    // The script is alive: a later saved Off from the popup is followed without a reload.
    const { intentCommitted: _c, ...off } = await new AtomicSettingsWriter(new InMemoryStorageAdapter(newer))
      .commit({ path: "sites.instagram.suggested", value: false, updatedAt: 20 });
    world.setApp(off as StoredSettingsRecord);
    await chrome.storage.local.set({ "still:settings": structuredClone(off) });
    for (let i = 0; i < 5; i++) await tick();
    expect(shown("target-sidebar-suggestions"), "Suggested accounts back after Off").toBe(true);
  });
});
