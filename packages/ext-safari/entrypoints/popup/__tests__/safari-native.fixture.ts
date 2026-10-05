import { vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import {
  AtomicSettingsWriter,
  InMemoryStorageAdapter,
  type SettingsIntent,
  type StoredSettingsRecord,
} from "@still/core/storage";

// A synthetic Safari extension page: `browser`/`chrome` with browser.storage.local and a native
// port backed by the real TypeScript atomic writer (the same contract the Swift App Group store
// implements; settings-storage.test.ts uses the same shape). Every native message is logged so a
// test can prove exactly what was read and written.

export type SavedShape = "atomic" | "legacy" | "absent";

export const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000aa";

export async function installSafari(options: {
  saved: SavedShape;
  platform?: string;
  signedIn?: boolean;
  /** Seed browser.storage.local with the app's current record (the background's projection). */
  projection?: boolean;
}) {
  const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 });
  const writer = new AtomicSettingsWriter(storage);
  if (options.saved === "atomic") {
    await writer.initialize("unknown");
    // A saved Off the page must never rewrite.
    await writer.commit({ path: "services.tiktok", value: false, updatedAt: 2 });
  }
  const nativeRecord = async (): Promise<StoredSettingsRecord | null> =>
    options.saved === "absent" ? null : structuredClone(await storage.get());

  const store: Record<string, unknown> = {};
  if (options.projection) store["still:settings"] = await nativeRecord();
  const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  const native: Record<string, unknown>[] = [];
  let nativeDown = false;
  const sendNativeMessage = vi.fn(async (_app: string, message: Record<string, unknown>) => {
    native.push(structuredClone(message));
    if (nativeDown) throw new Error("native host unavailable");
    switch (message.kind) {
      case "get": {
        const record = await nativeRecord();
        return { settings: record ? JSON.stringify(record) : "" };
      }
      case "settingsIntent": {
        const { kind: _kind, ...intent } = message;
        const result = await writer.commit(intent as unknown as SettingsIntent);
        const { intentCommitted, ...record } = result;
        return { settings: JSON.stringify({ status: "committed", changed: intentCommitted === true, record }) };
      }
      case "getAccountSyncStatus":
        return {
          accountSyncStatus: options.signedIn
            ? { accountId: ACCOUNT_ID, email: "person@example.invalid", lastSyncedAt: 5, pendingUpload: false, cloudReachable: true, updatedAt: 5 }
            : null,
        };
      default:
        return {};
    }
  });
  const messages: Record<string, unknown>[] = [];
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    messages.push(structuredClone(message));
    // jsdom cannot run a page at the opaque safari-web-extension: origin (no localStorage), so
    // the page adapter takes its non-Safari-origin read route. It is answered here by the same
    // native record and logged as a native `get`; on a real Safari page it IS a direct native get.
    if (message.kind === "still:settings-read") {
      native.push({ kind: "get" });
      if (nativeDown) return { status: "unavailable" };
      return { status: "ready", record: await nativeRecord() };
    }
    return undefined;
  });
  const openOptionsPage = vi.fn(async () => {});
  const set = vi.fn(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) {
      const oldValue = store[key];
      store[key] = structuredClone(value);
      for (const listener of [...listeners]) listener({ [key]: { oldValue, newValue: structuredClone(value) } }, "local");
    }
  });
  const api = {
    runtime: {
      id: "still",
      getURL: (path = "") => `safari-web-extension://still/${path}`,
      getManifest: () => ({ version: "test" }),
      getPlatformInfo: async () => ({ os: options.platform ?? "ios" }),
      sendNativeMessage,
      sendMessage,
      openOptionsPage,
    },
    storage: {
      local: {
        get: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
        },
        set,
      },
      onChanged: {
        addListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) =>
          listeners.add(listener),
        removeListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) =>
          listeners.delete(listener),
      },
    },
  };
  vi.stubGlobal("chrome", api);
  vi.stubGlobal("browser", api);
  return {
    storage,
    store,
    native,
    messages,
    sendNativeMessage,
    openOptionsPage,
    nativeKinds: () => native.map((m) => m.kind),
    nativeRecord,
    setNativeDown(down: boolean) {
      nativeDown = down;
    },
  };
}

/** Write kinds the extension must never send on its own (anything but a deliberate intent). */
export const UNPROMPTED_WRITES = ["set", "settingsAtomic", "settingsIntent"];
