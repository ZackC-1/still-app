import type { AnalyticsKeyValue } from "./identity.js";

// A key-value slot in IndexedDB, for the analytics queue in the browser extensions' backgrounds.
//
// Why not extension storage: every chrome.storage.local write is broadcast, old and new value, to
// every context listening for storage changes, including the content scripts on each open YouTube,
// Instagram, Facebook and TikTok tab. storage.session avoids that, but it is missing on the Safari
// versions Still supports before 16.4, and it is cleared when the browser quits. IndexedDB belongs to
// the extension's own origin: content scripts run in the page's origin and never see it, and it
// persists across restarts on every supported browser.
//
// If IndexedDB cannot be opened (a private window, a browser that refuses it), the slot falls back
// to memory: events then live only as long as the background, which loses some but exposes none.

export function createIndexedDbKeyValue(
  dbName = "still-analytics",
  factory: IDBFactory | undefined = globalThis.indexedDB,
): AnalyticsKeyValue {
  const memory = new Map<string, unknown>();
  let dbPromise: Promise<IDBDatabase | null> | null = null;

  const open = (): Promise<IDBDatabase | null> =>
    (dbPromise ??= new Promise((resolve) => {
      if (!factory) return resolve(null);
      try {
        const request = factory.open(dbName, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("kv")) request.result.createObjectStore("kv");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    }));

  const run = <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>) =>
    open().then(
      (db) =>
        new Promise<T | undefined>((resolve, reject) => {
          if (!db) return resolve(undefined);
          const tx = db.transaction("kv", mode);
          const request = body(tx.objectStore("kv"));
          tx.oncomplete = () => resolve(request.result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
    );

  return {
    async get(key) {
      const db = await open();
      if (!db) return memory.get(key) ?? null;
      return (await run("readonly", (store) => store.get(key))) ?? null;
    },
    async set(key, value) {
      const db = await open();
      if (!db) {
        memory.set(key, structuredClone(value));
        return;
      }
      await run("readwrite", (store) => store.put(structuredClone(value), key));
    },
  };
}
