import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import {
  ChromeStorageAdapter,
  type ChromeSettingsAuthorityOptions,
} from "../chrome-adapter.js";
import { InMemoryStorageAdapter, type StorageAdapter } from "../adapter.js";
import { migrateSettingsV2 } from "../settings-v2.js";

const KEY = "still:settings";
const valid = {
  settings: { ...DEFAULT_SETTINGS, globalOn: false, updatedAt: 10 },
  syncMetadata: null,
};
type Handler = (
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
) => void;
const invalidChanges: [string, chrome.storage.StorageChange][] = [
  ["deletion", { oldValue: valid }],
  ["keyed null", { newValue: null }],
  ["keyed undefined", { newValue: undefined }],
  ["empty string", { newValue: "" }],
  ["malformed JSON", { newValue: "{broken" }],
  ["wrong shape", { newValue: { settings: { globalOn: "yes" } } }],
  [
    "corrupt metadata",
    { newValue: { ...valid, syncMetadata: { version: -1 } } },
  ],
  [
    "future schema",
    {
      newValue: {
        ...valid,
        settings: { ...valid.settings, schemaVersion: 999 },
      },
    },
  ],
];

function browser(url = "chrome-extension://still/") {
  const listeners = new Set<Handler>();
  let stored: Record<string, unknown> = { [KEY]: valid };
  const local = {
    get: vi.fn(async () => stored),
    set: vi.fn(async () => undefined),
  };
  const runtime = {
    getURL: vi.fn(() => url),
    sendMessage: vi.fn(),
    sendNativeMessage: vi.fn(),
  };
  const onChanged = {
    addListener: vi.fn((handler: Handler) => {
      listeners.add(handler);
    }),
    removeListener: vi.fn((handler: Handler) => {
      listeners.delete(handler);
    }),
  };
  vi.stubGlobal("chrome", { storage: { local, onChanged }, runtime });
  return {
    local,
    runtime,
    onChanged,
    listeners,
    store(value: Record<string, unknown>) {
      stored = value;
    },
    emit(
      changes: Record<string, chrome.storage.StorageChange>,
      area = "local",
    ) {
      for (const handler of [...listeners]) handler(changes, area);
    },
    expectNoIO() {
      expect(local.get).not.toHaveBeenCalled();
      expect(local.set).not.toHaveBeenCalled();
      expect(runtime.sendMessage).not.toHaveBeenCalled();
      expect(runtime.sendNativeMessage).not.toHaveBeenCalled();
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser raw settings invalidation observation", () => {
  it("exposes an optional StorageAdapter signal", () => {
    browser();
    const adapter: StorageAdapter = new ChromeStorageAdapter();
    expect(typeof adapter.subscribeInvalidation).toBe("function");
  });
  it("keeps the signal optional for existing adapters", () => {
    const adapter: StorageAdapter = new InMemoryStorageAdapter();
    expect(adapter.subscribeInvalidation).toBeUndefined();
  });
  it("also observes a browser authority without entering its writer", () => {
    const host = browser();
    const signal = vi.fn();
    const stop = new ChromeStorageAdapter({
      authority: true,
    }).subscribeInvalidation(signal);
    host.emit({ [KEY]: { oldValue: valid } });
    expect(signal.mock.calls).toEqual([[]]);
    host.expectNoIO();
    stop();
  });
  it("keeps supported modern records on the existing subscription only", () => {
    const migrated = migrateSettingsV2(valid.settings, {
      kind: "readable-local",
    });
    if (migrated.status !== "ready")
      throw new Error("Expected supported modern fixture");
    const modern = {
      settings: { ...migrated.settings, pauses: [] },
      syncMetadata: null,
    };
    const host = browser();
    const adapter = new ChromeStorageAdapter();
    const signal = vi.fn();
    const record = vi.fn();
    const stop = adapter.subscribeInvalidation(signal);
    const stopRecord = adapter.subscribe(record);
    host.emit({ [KEY]: { newValue: modern } });
    expect(signal).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledExactlyOnceWith(modern);
    host.expectNoIO();
    stop();
    stopRecord();
  });
  describe.each(["chrome-extension://still/", "moz-extension://still/"])(
    "%s",
    (url) => {
      it.each(invalidChanges)(
        "signals %s without a payload or storage IO",
        (_name, change) => {
          const host = browser(url);
          const signal = vi.fn();
          const record = vi.fn();
          const adapter = new ChromeStorageAdapter();
          const stopRecords = adapter.subscribe(record);
          const stop = adapter.subscribeInvalidation(signal);
          host.emit({ [KEY]: change });
          expect(signal.mock.calls).toEqual([[]]);
          expect(record).not.toHaveBeenCalled();
          host.expectNoIO();
          stop();
          stopRecords();
          expect(host.listeners.size).toBe(0);
        },
      );
    },
  );
  it.each([
    valid,
    valid.settings,
    JSON.stringify(valid),
    JSON.stringify(valid.settings),
  ])("keeps valid records on the existing subscription only (%j)", (value) => {
    const host = browser();
    const adapter = new ChromeStorageAdapter();
    const signal = vi.fn();
    const record = vi.fn();
    const stop = adapter.subscribeInvalidation(signal);
    const stopRecords = adapter.subscribe(record);
    host.emit({ [KEY]: { newValue: value } });
    expect(signal).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledExactlyOnceWith(valid);
    host.expectNoIO();
    stop();
    stopRecords();
  });
  it.each(["sync", "session", "managed", "unknown"])(
    "ignores %s storage",
    (area) => {
      const host = browser();
      const signal = vi.fn();
      const stop = new ChromeStorageAdapter().subscribeInvalidation(signal);
      host.emit({ [KEY]: { oldValue: valid } }, area);
      expect(signal).not.toHaveBeenCalled();
      host.expectNoIO();
      stop();
    },
  );
  it("ignores unrelated, empty, and inherited keys", () => {
    const host = browser();
    const signal = vi.fn();
    const stop = new ChromeStorageAdapter().subscribeInvalidation(signal);
    host.emit({ other: { newValue: null } });
    host.emit({});
    host.emit(
      Object.create({ [KEY]: { oldValue: valid } }) as Record<
        string,
        chrome.storage.StorageChange
      >,
    );
    expect(signal).not.toHaveBeenCalled();
    host.expectNoIO();
    stop();
  });
  it.each([
    "safari-web-extension://still/",
    "https://still/",
    "",
    "chrome-extension:invalid",
    "moz-extension:invalid",
  ])("ignores native or unknown runtime %s even on a browser page", (url) => {
    const host = browser(url);
    vi.stubGlobal("location", { protocol: "chrome-extension:" });
    const signal = vi.fn();
    const stop = new ChromeStorageAdapter().subscribeInvalidation(signal);
    host.emit({ [KEY]: { oldValue: valid } });
    expect(signal).not.toHaveBeenCalled();
    host.expectNoIO();
    stop();
  });
  it.each(["missing", "throws"])(
    "stays silent when runtime getURL %s",
    (kind) => {
      const host = browser();
      if (kind === "missing")
        vi.stubGlobal("chrome", {
          storage: { local: host.local, onChanged: host.onChanged },
          runtime: {},
        });
      else
        host.runtime.getURL.mockImplementation(() => {
          throw new Error("unavailable");
        });
      const signal = vi.fn();
      const stop = new ChromeStorageAdapter().subscribeInvalidation(signal);
      expect(() => host.emit({ [KEY]: { oldValue: valid } })).not.toThrow();
      expect(signal).not.toHaveBeenCalled();
      host.expectNoIO();
      stop();
    },
  );
  it.each<ChromeSettingsAuthorityOptions>([
    { nativeMirror: true },
    { nativeIntent: vi.fn() },
    { authority: true, nativeMirror: true },
  ])(
    "excludes native authority options %j on a Chromium runtime",
    (options) => {
      const host = browser();
      const signal = vi.fn();
      const stop = new ChromeStorageAdapter(options).subscribeInvalidation(
        signal,
      );
      host.emit({ [KEY]: { oldValue: valid } });
      expect(signal).not.toHaveBeenCalled();
      host.expectNoIO();
      stop();
    },
  );
  it("uses the current runtime rather than a remembered browser host", () => {
    const host = browser();
    const signal = vi.fn();
    const stop = new ChromeStorageAdapter().subscribeInvalidation(signal);
    host.runtime.getURL.mockReturnValue("safari-web-extension://still/");
    host.emit({ [KEY]: { newValue: null } });
    expect(signal).not.toHaveBeenCalled();
    host.expectNoIO();
    stop();
  });
  it("detaches only its own listener and fences retained handlers", () => {
    const host = browser();
    const adapter = new ChromeStorageAdapter();
    const first = vi.fn();
    const second = vi.fn();
    const records = vi.fn();
    const stopFirst = adapter.subscribeInvalidation(first);
    const retained = [...host.listeners][0]!;
    const stopSecond = adapter.subscribeInvalidation(second);
    const stopRecords = adapter.subscribe(records);
    stopFirst();
    stopFirst();
    expect(host.listeners.size).toBe(2);
    retained({ [KEY]: { newValue: null } }, "local");
    host.emit({ [KEY]: { newValue: null } });
    expect(first).not.toHaveBeenCalled();
    expect(second.mock.calls).toEqual([[]]);
    host.emit({ [KEY]: { newValue: valid } });
    expect(records).toHaveBeenCalledExactlyOnceWith(valid);
    host.expectNoIO();
    stopSecond();
    stopRecords();
    expect(host.listeners.size).toBe(0);
  });
  it("contains a listener error while other subscriptions still receive events", () => {
    const host = browser();
    const adapter = new ChromeStorageAdapter();
    const stopBad = adapter.subscribeInvalidation(() => {
      throw new Error("listener failed");
    });
    const signal = vi.fn();
    const record = vi.fn();
    const stopGood = adapter.subscribeInvalidation(signal);
    const stopRecord = adapter.subscribe(record);
    expect(() => host.emit({ [KEY]: { newValue: null } })).not.toThrow();
    expect(signal.mock.calls).toEqual([[]]);
    host.emit({ [KEY]: { newValue: valid } });
    expect(record).toHaveBeenCalledExactlyOnceWith(valid);
    host.expectNoIO();
    stopBad();
    stopGood();
    stopRecord();
  });
  it.each(invalidChanges)(
    "leaves absence versus unreadable to a separate actual get after %s",
    async (_name, change) => {
      const host = browser();
      const adapter = new ChromeStorageAdapter();
      const signal = vi.fn();
      const stop = adapter.subscribeInvalidation(signal);
      host.store(
        Object.hasOwn(change, "newValue") ? { [KEY]: change.newValue } : {},
      );
      host.emit({ [KEY]: change });
      expect(signal.mock.calls).toEqual([[]]);
      host.expectNoIO();
      if (!Object.hasOwn(change, "newValue"))
        await expect(adapter.get()).resolves.toBeNull();
      else await expect(adapter.get()).rejects.toThrow("unreadable");
      expect(host.local.get).toHaveBeenCalledExactlyOnceWith(KEY);
      expect(host.local.set).not.toHaveBeenCalled();
      expect(host.runtime.sendMessage).not.toHaveBeenCalled();
      expect(host.runtime.sendNativeMessage).not.toHaveBeenCalled();
      stop();
    },
  );
});
