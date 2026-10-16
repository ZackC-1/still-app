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
const SESSION_ID = "00000000-0000-4000-8000-0000000000cc";
const LINEAGE = "00000000-0000-4000-8000-0000000000bb";

/**
 * How the synthetic native host behaves, to model the real Safari native-messaging channel.
 * `latencyMs` delays each settings or account reply (`get`, `settingsIntent`,
 * `getAccountSyncStatus`) so a page's requests can overlap; `busy: "reject"` makes the host refuse
 * a second such message while an earlier one is still outstanding, the overlap that froze the real
 * Safari popups (ISS-0050).
 */
export interface SafariHostBehavior {
  readonly latencyMs?: (kind: string) => number;
  readonly busy?: "reject";
}

export async function installSafari(options: {
  saved: SavedShape;
  platform?: string;
  signedIn?: boolean;
  /** Seed browser.storage.local with the app's current record (the background's projection). */
  projection?: boolean;
  /** What the app's App Group answers to a `getEntitlement` pull (absent: no stamp, an empty reply). */
  entitlement?: { entitled: boolean; updatedAt: number; installId?: string };
  /**
   * The atomic record's account shape: "unknown" (default), "signed-out" (local edits after an
   * earlier account, previous-account ownership) or "signed-in" (an acknowledged account scope).
   */
  account?: "unknown" | "signed-out" | "signed-in";
  /** Page settings reads go straight to the native host, as on a real Safari extension page. */
  nativeReads?: boolean;
  host?: SafariHostBehavior;
}) {
  const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 });
  const writer = new AtomicSettingsWriter(storage);
  if (options.saved === "atomic") {
    const account = options.account ?? "unknown";
    const initial = await writer.initialize(account === "unknown" ? "unknown" : "never-linked");
    if (account !== "unknown") {
      const entered = await writer.enterScope(ACCOUNT_ID, SESSION_ID);
      await writer.acknowledge({ protocol: 2, empty: false, settings: initial.settings, version: 1,
        serverUpdatedAt: "2026-10-15T00:00:00Z", lastWriteId: null, lineage: LINEAGE,
        receipt: { version: 1, lineage: LINEAGE, revision: 1, mac: "A".repeat(43) } } as never, entered.atomic!.scope);
      if (account === "signed-out") await writer.enterScope(null);
    }
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
  // While held, every settings read waits (a first read that has not answered yet).
  let readGate: Promise<void> | null = null;
  let releaseGate: () => void = () => {};
  let outstanding = 0;
  const busyRefusals: string[] = [];
  const answer = vi.fn(async (_app: string, message: Record<string, unknown>) => {
    switch (message.kind) {
      case "get": {
        if (readGate) await readGate;
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
          accountSyncStatus: options.signedIn || options.account === "signed-in"
            ? { accountId: ACCOUNT_ID, email: "person@example.invalid", lastSyncedAt: 5, pendingUpload: false, cloudReachable: true, updatedAt: 5 }
            : null,
        };
      case "getEntitlement":
        return { entitlement: options.entitlement ? JSON.stringify(options.entitlement) : "" };
      case "openAppRoute":
        // The app's handler (StillAppRoute): the Mac opens the app; an iPhone extension cannot.
        return {
          openAppRoute: {
            ok: options.platform === "mac" && (message.route === "pro" || message.route === "sync"),
            route: message.route === "pro" || message.route === "sync" ? message.route : null,
          },
        };
      default:
        return {};
    }
  });
  // The page's settings and account reads/writes: the messages the Safari popup sends repeatedly.
  const settingsKinds = new Set(["get", "settingsIntent", "getAccountSyncStatus"]);
  const sendNativeMessage = vi.fn(async (app: string, message: Record<string, unknown>) => {
    native.push(structuredClone(message));
    if (nativeDown) throw new Error("native host unavailable");
    const kind = String(message.kind);
    if (!settingsKinds.has(kind)) return answer(app, message);
    if (options.host?.busy === "reject" && outstanding > 0) {
      busyRefusals.push(kind);
      throw new Error("native host busy");
    }
    outstanding += 1;
    try {
      const latency = options.host?.latencyMs?.(kind) ?? 0;
      if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
      return await answer(app, message);
    } finally {
      outstanding -= 1;
    }
  });
  if (options.nativeReads) vi.stubGlobal("location", { protocol: "safari-web-extension:", href: "safari-web-extension://still/popup.html" });
  const messages: Record<string, unknown>[] = [];
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    messages.push(structuredClone(message));
    // jsdom cannot run a page at the opaque safari-web-extension: origin (no localStorage), so
    // the page adapter takes its non-Safari-origin read route. It is answered here by the same
    // native record and logged as a native `get`; on a real Safari page it IS a direct native get.
    if (message.kind === "still:settings-read") {
      native.push({ kind: "get" });
      if (readGate) await readGate;
      if (nativeDown) return { status: "unavailable" };
      return { status: "ready", record: await nativeRecord() };
    }
    return undefined;
  });
  const openOptionsPage = vi.fn(async () => {});
  const createTab = vi.fn(async (_properties: { url: string }) => ({}));
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
    tabs: { create: createTab },
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
    createTab,
    nativeKinds: () => native.map((m) => m.kind),
    /** Settings messages the host refused because another from the page was outstanding. */
    busyRefusals,
    nativeRecord,
    setNativeDown(down: boolean) {
      nativeDown = down;
    },
    /** Make every settings read wait until `releaseReads()`. */
    holdReads() {
      readGate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    },
    releaseReads() {
      readGate = null;
      releaseGate();
    },
    /** How many `chrome.storage.onChanged` listeners are attached right now. */
    storageListenerCount: () => listeners.size,
  };
}

/** Write kinds the extension must never send on its own (anything but a deliberate intent). */
export const UNPROMPTED_WRITES = ["set", "settingsAtomic", "settingsIntent"];
