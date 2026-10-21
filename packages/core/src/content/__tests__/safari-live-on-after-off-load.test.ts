import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type SettingsField } from "@still/shared-types";
import { createModernShippingContentEntry } from "../modern-shipping-entry.js";
import type { ContentScriptHandle, StillWindow } from "../index.js";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter, type StoredSettingsRecord } from "../../storage/adapter.js";
import { ChromeStorageAdapter } from "../../storage/chrome-adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { SettingsStorageRecovery } from "../../storage/atomic-settings.js";

const scripts: ContentScriptHandle[] = [];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const tab = "fb-mobile-page-tab-reels";
const hidden = (id: string): boolean => {
  for (let at = document.getElementById(id); at; at = at.parentElement)
    if (getComputedStyle(at).display === "none") return true;
  return false;
};

afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

/**
 * A Safari content-script world. Settings reads go to the background by message; with `reads`
 * "unavailable" every one of them comes back unusable, as a refused, lost or late native reply
 * does, so the page has only the browser-storage copy the popup mirrors after each switch.
 */
type Reads = "ready" | "unavailable" | "rejects";

function safariWorld(app: StoredSettingsRecord, reads: Reads = "ready") {
  const values: Record<string, unknown> = { "still:settings": structuredClone(app) };
  const listeners = new Set<(changes: Record<string, { oldValue?: unknown; newValue: unknown }>, area: string) => void>();
  // The background's answer to one settings read; a test may replace it (a slow reply).
  let answer = (): Promise<unknown> => {
    if (reads === "rejects") return Promise.reject(new Error("Could not establish connection")); // background asleep
    return Promise.resolve(reads === "ready" ? { status: "ready", record: structuredClone(app) } : { status: "unavailable" });
  };
  const sendMessage = vi.fn(async (message: { kind?: string }) => {
    if (message.kind === "still:settings-read") return answer();
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
  const writer = new AtomicSettingsWriter(new InMemoryStorageAdapter(app));
  return {
    sendMessage,
    setReads: (next: Reads) => { reads = next; },
    answerWith: (next: () => Promise<unknown>) => { answer = next; },
    /** Write a record into browser storage directly, as a stale or racing mirror would. */
    mirror: (record: StoredSettingsRecord) => chrome.storage.local.set({ "still:settings": structuredClone(record) }),
    /** The popup's switch: one native intent, then the committed record mirrored into storage. */
    async popup(path: SettingsField, value: boolean, mirror = true) {
      const { intentCommitted: _c, ...next } = await writer.commit({ path, value, updatedAt: Date.now() });
      app = next as StoredSettingsRecord;
      if (mirror) await chrome.storage.local.set({ "still:settings": structuredClone(app) });
    },
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

async function appRecord(path: SettingsField, value: boolean): Promise<StoredSettingsRecord> {
  const writer = new AtomicSettingsWriter(new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 }));
  await writer.initialize("never-linked");
  const { intentCommitted: _c, ...off } = await writer.commit({ path, value, updatedAt: 5 });
  return off as StoredSettingsRecord;
}

describe("Safari page loaded with Facebook Off, then On from the popup (ISS-0084)", () => {
  it.each([
    ["services.facebook", "ready"],
    ["sites.facebook.reels", "ready"],
    ["globalOn", "ready"],
    // The device case: the reload applies the mirrored copy, so the live switch must too.
    ["services.facebook", "unavailable"],
    ["sites.facebook.reels", "unavailable"],
    ["globalOn", "unavailable"],
    ["services.facebook", "rejects"],
  ] as const)("%s, background reads %s: a live On hides the Page Reels tab without a reload, a live Off shows it", async (path, reads) => {
    const world = safariWorld(await appRecord(path, false), reads);
    const html = readFileSync(resolve("../../tests/fixtures", "facebook-mobile-page.html"), "utf8");
    document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
    await createModernShippingContentEntry({ host: "safari", storage: chrome.storage.local, prod: false,
      earlyRedirect: true, pendingCover: true, win: pageWindow("https://m.facebook.com/stilltestpage/"), doc: document,
      onScriptCreated: (script) => scripts.push(script) })({ onInvalidated: () => {} });
    for (let i = 0; i < 5; i++) await tick();
    expect(scripts).toHaveLength(1);
    expect(hidden(tab), "loaded Off: tab shown").toBe(false);

    await world.popup(path, true);
    for (let i = 0; i < 5; i++) await tick();
    expect(document.documentElement.className).toMatch(/still-feature-\d+-facebook-reels/);
    expect(hidden(tab), "live On: tab hidden").toBe(true);

    await world.popup(path, false);
    for (let i = 0; i < 5; i++) await tick();
    expect(hidden(tab), "live Off again: tab shown").toBe(false);
  });

  it("background reads unavailable: the browser-storage copy reaches the open page once, then the timed rereads change nothing", async () => {
    vi.useFakeTimers();
    const world = safariWorld(await appRecord("services.facebook", false), "unavailable");
    const html = readFileSync(resolve("../../tests/fixtures", "facebook-mobile-page.html"), "utf8");
    document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
    await createModernShippingContentEntry({ host: "safari", storage: chrome.storage.local, prod: false,
      earlyRedirect: true, win: pageWindow("https://m.facebook.com/stilltestpage/"), doc: document,
      onScriptCreated: (script) => scripts.push(script) })({ onInvalidated: () => {} });
    await vi.advanceTimersByTimeAsync(10);
    await world.popup("services.facebook", true);
    await vi.advanceTimersByTimeAsync(10);
    expect(hidden(tab)).toBe(true);
    const writes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => writes.push(...records));
    observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
    const reads = world.sendMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000); // six timed rereads, every one unavailable
    await Promise.resolve();
    observer.disconnect();
    expect(world.sendMessage.mock.calls.length).toBeGreaterThan(reads);
    expect(writes, "no DOM work while nothing changed").toHaveLength(0);
    expect(hidden(tab)).toBe(true);
  });

  it("a failed reread never downgrades: an older browser-storage copy is refused and the newer app record stays", async () => {
    vi.useFakeTimers();
    // The app holds On (newer); browser storage still holds the older Off copy.
    const older = await appRecord("services.facebook", false);
    const { intentCommitted: _c, ...newer } = await new AtomicSettingsWriter(new InMemoryStorageAdapter(older))
      .commit({ path: "services.facebook", value: true, updatedAt: 10 });
    const world = safariWorld(newer as StoredSettingsRecord);
    await world.mirror(older);
    const html = readFileSync(resolve("../../tests/fixtures", "facebook-mobile-page.html"), "utf8");
    document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
    await createModernShippingContentEntry({ host: "safari", storage: chrome.storage.local, prod: false,
      earlyRedirect: true, win: pageWindow("https://m.facebook.com/stilltestpage/"), doc: document,
      onScriptCreated: (script) => scripts.push(script) })({ onInvalidated: () => {} });
    const probe = new SettingsCache(new ChromeStorageAdapter());
    const unwatch = probe.watch();
    await probe.hydrate();
    await vi.advanceTimersByTimeAsync(10);
    expect(hidden(tab), "the app's newer On applied").toBe(true);
    expect(probe.currentRecord().atomic?.sequence).toBe(newer.atomic!.sequence);

    // The app becomes unreachable and the older copy is written to storage again.
    world.setReads("unavailable");
    const writes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => writes.push(...records));
    observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
    await world.mirror(older);
    await vi.advanceTimersByTimeAsync(12_000); // the signal's reread and two timed rereads, all failing
    observer.disconnect();
    unwatch();
    expect(writes, "nothing changes on the page").toHaveLength(0);
    expect(hidden(tab)).toBe(true);
    expect(probe.currentRecord().atomic?.sequence).toBe(newer.atomic!.sequence);
    expect(probe.current().services.facebook).toBe(true);
  });

  it("a retained copy blocks without counting as a successful app read; the next successful read clears that", async () => {
    vi.useFakeTimers();
    const world = safariWorld(await appRecord("services.facebook", false), "unavailable");
    const probe = new SettingsCache(new ChromeStorageAdapter());
    const unwatch = probe.watch();
    await probe.hydrate();
    await world.popup("services.facebook", true);
    await vi.advanceTimersByTimeAsync(10);
    expect(probe.current().services.facebook).toBe(true);
    // As after a failed first read: still in recovery, atomic state paused.
    await expect(probe.whenHydrated()).rejects.toBeInstanceOf(SettingsStorageRecovery);
    expect(probe.currentRecord().atomic?.paused).toBe("native-authority-unavailable");

    world.setReads("ready");
    await vi.advanceTimersByTimeAsync(5_000); // the next timed reread succeeds
    unwatch();
    await expect(probe.whenHydrated()).resolves.toBeUndefined();
    expect(probe.currentRecord().atomic?.paused).toBeNull();
    expect(probe.current().services.facebook).toBe(true);
  });

  it("a superseded slow reread delivers nothing; only the newer reread does", async () => {
    vi.useFakeTimers();
    const first = await appRecord("services.facebook", false);
    const world = safariWorld(first);
    const delivered: Array<{ facebook: boolean; retained: boolean }> = [];
    const unsubscribe = new ChromeStorageAdapter().subscribe((record, recovery) =>
      delivered.push({ facebook: record.settings.services.facebook, retained: recovery !== undefined }));
    // The first reread's background reply is slow; it answers later with the old record.
    let answerSlow!: (value: unknown) => void;
    world.answerWith(() => new Promise((resolve) => { answerSlow = resolve; }));
    await world.mirror(first);
    await vi.advanceTimersByTimeAsync(10);
    expect(world.sendMessage).toHaveBeenCalledTimes(1);

    // A newer switch arrives while that read is out; its own reread fails, so it carries the copy.
    world.answerWith(() => Promise.resolve({ status: "unavailable" }));
    await world.popup("services.facebook", true);
    await vi.advanceTimersByTimeAsync(10);
    answerSlow({ status: "ready", record: structuredClone(first) }); // the superseded reply, late
    await vi.advanceTimersByTimeAsync(10);
    unsubscribe();
    expect(world.sendMessage).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual([{ facebook: true, retained: true }]);
  });
});
