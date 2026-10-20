import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { SettingsCache } from "../cache.js";
import { AtomicSettingsWriter, SettingsStorageRecovery, requireModernSettings } from "../atomic-settings.js";
import { InMemoryStorageAdapter } from "../adapter.js";
import type { StorageAdapter, StoredSettingsRecord } from "../adapter.js";

// ISS-0107. A Safari content script reads its settings from the app (through the background), and
// on Safari the modern content lane starts watching BEFORE its first read. When a page loads just
// after popup toggles, the page's own reconcile nudge mirrors the newer saved record into browser
// storage, which makes the page reread while its first read is still out. If that first read then
// fails (native reply refused, lost or late), it used to reject hydrate() although a newer saved
// record had already been accepted. The content script treats a rejected start as fatal and stops,
// so the page kept no Still Pro extras (and no script-driven blocking) until a reload.

const SITES_STORIES = "sites.instagram.stories" as const;

async function savedRecords() {
  const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
  const writer = new AtomicSettingsWriter(storage);
  const older = await writer.initialize("never-linked");
  const newer = await writer.commit({ path: SITES_STORIES, value: true, updatedAt: 10 });
  const { intentCommitted: _committed, ...stored } = newer;
  return { older, newer: stored as StoredSettingsRecord };
}

/** The Safari content adapter's shape: a first read that the test fails, and a subscription that
 * delivers what a successful authority reread returned. */
function contentAdapter(retained: StoredSettingsRecord | null) {
  let fail!: () => void;
  const listeners = new Set<(record: StoredSettingsRecord) => void>();
  const adapter: StorageAdapter = {
    get: () => new Promise<StoredSettingsRecord | null>((_resolve, reject) => {
      fail = () => reject(new SettingsStorageRecovery("native-authority-unavailable", retained));
    }),
    set: async () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    adapter,
    failFirstRead: () => fail(),
    deliver: (record: StoredSettingsRecord) => {
      for (const listener of [...listeners]) listener(structuredClone(record));
    },
  };
}

describe("a first settings read superseded by a newer accepted record (ISS-0107)", () => {
  it.each([
    ["an older retained projection", true],
    ["no retained projection", false],
  ] as const)("resolves with the newer record when the read then fails with %s", async (_name, withRetained) => {
    const { older, newer } = await savedRecords();
    const content = contentAdapter(withRetained ? older : null);
    const cache = new SettingsCache(content.adapter);
    const stop = cache.watch(); // the modern content lane watches before it hydrates
    try {
      const hydrating = cache.hydrate();
      content.deliver(newer); // the page's reread, triggered by the nudge's projection write
      content.failFirstRead();
      await expect(hydrating).resolves.toBeDefined();
      expect(requireModernSettings(cache.currentRecord()).sites["instagram.stories"]).toBe(true);
      expect(cache.currentRecord().atomic?.sequence).toBe(newer.atomic!.sequence);
      // The accepted read is a successful authority read: nothing is held.
      await expect(cache.whenHydrated()).resolves.toBeUndefined();
    } finally {
      stop();
    }
  });

  it("still rejects an unsuperseded failed first read with nothing retained", async () => {
    const content = contentAdapter(null);
    const cache = new SettingsCache(content.adapter);
    const stop = cache.watch();
    try {
      const hydrating = cache.hydrate();
      content.failFirstRead();
      await expect(hydrating).rejects.toThrow("native-authority-unavailable");
    } finally {
      stop();
    }
  });

  it("still takes the retained projection for an unsuperseded failed first read", async () => {
    const { older } = await savedRecords();
    const content = contentAdapter(older);
    const cache = new SettingsCache(content.adapter);
    const stop = cache.watch();
    try {
      const hydrating = cache.hydrate();
      content.failFirstRead();
      await expect(hydrating).resolves.toBeDefined();
      expect(cache.currentRecord().atomic?.sequence).toBe(older.atomic!.sequence);
      expect(cache.currentRecord().atomic?.paused).toBe("native-authority-unavailable");
    } finally {
      stop();
    }
  });
});
