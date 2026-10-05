import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { ChromeStorageAdapter } from "../chrome-adapter.js";
import { createSettingsIntentRouter } from "../settings-messages.js";
import { migrateSettingsV2 } from "../settings-v2.js";
import type { SettingsIntent } from "../atomic-settings.js";

const KEY = "still:settings";
const ORIGIN = "chrome-extension://still/";

function retainedRecord(versioned = true) {
  return {
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      ...(versioned ? { schemaVersion: 1 } : {}),
      globalOn: false,
      services: {
        youtube: false,
        instagram: true,
        tiktok: false,
        facebook: true,
        futureService: { retained: "opaque service choice" },
      },
      updatedAt: 100,
      futureSettings: { retained: [false, "opaque settings choice"] },
    },
    syncMetadata: {
      version: 7,
      serverUpdatedAt: "2026-10-02T00:00:00Z",
      lastWriteId: "11111111-1111-1111-1111-111111111111",
    },
    syncEpoch: 3,
    futureRoot: { retained: { custom: false } },
  };
}

// Only the browser transport/storage are synthetic. The consumer, authority, serialized writer
// and authenticated intent router are the maintained production implementation, without migration.
function browser(record: unknown) {
  let durable: unknown = structuredClone(record);
  const local = {
    get: vi.fn(async () => ({ [KEY]: structuredClone(durable) })),
    set: vi.fn(async (values: Record<string, unknown>) => {
      durable = structuredClone(values[KEY]);
    }),
  };
  const sendMessage = vi.fn<(message: unknown) => Promise<unknown>>();
  vi.stubGlobal("chrome", {
    storage: {
      local,
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { getURL: () => ORIGIN, sendMessage },
  });
  const authority = new ChromeStorageAdapter({ authority: true });
  const route = createSettingsIntentRouter(
    authority.commitIntent.bind(authority),
    "still",
    ORIGIN,
  );
  sendMessage.mockImplementation(
    (message) =>
      new Promise((resolve, reject) => {
        if (
          !route(
            structuredClone(message),
            { id: "still", url: `${ORIGIN}popup.html` },
            (reply) => resolve(structuredClone(reply)),
          )
        ) {
          reject(new Error("Intent was not admitted"));
        }
      }),
  );
  return {
    authority,
    consumer: new ChromeStorageAdapter(),
    local,
    sendMessage,
    saved: () => structuredClone(durable),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("configured legacy intents through the Chrome authority router", () => {
  it.each(["globalOn", "services.youtube"] as const)(
    "commits a schema-1 %s edit without migrating or rewriting other choices",
    async (path) => {
      const before = retainedRecord();
      const h = browser(before);
      expect(await h.authority.get()).toEqual(before);
      const reply = await h.consumer.commitIntent({
        path,
        value: true,
        updatedAt: 50,
      });
      const settings =
        path === "globalOn"
          ? { ...before.settings, globalOn: true, updatedAt: 101 }
          : {
              ...before.settings,
              services: { ...before.settings.services, youtube: true },
              updatedAt: 101,
            };
      expect(h.saved()).toEqual({ ...before, settings });
      expect(reply.intentCommitted).toBe(true);
      expect(reply.settings.updatedAt).toBe(101);
      expect(h.local.set).toHaveBeenCalledTimes(1);
      expect(h.sendMessage).toHaveBeenCalledWith({
        kind: "still:settings-intent",
        path,
        value: true,
        updatedAt: 50,
      });
      expect(h.saved()).not.toHaveProperty("atomic");
      expect(h.saved()).not.toHaveProperty("intentCommitted");
      expect(await new ChromeStorageAdapter({ authority: true }).get()).toEqual(
        h.saved(),
      );
    },
  );

  it("allocates durable time for successive backward and same-time edits after reopening", async () => {
    const before = retainedRecord();
    const h = browser(before);
    const first = await h.consumer.commitIntent({
      path: "services.youtube",
      value: true,
      updatedAt: 50,
    });
    expect(first.intentCommitted).toBe(true);
    expect(h.saved()).toEqual({
      ...before,
      settings: {
        ...before.settings,
        services: { ...before.settings.services, youtube: true },
        updatedAt: 101,
      },
    });
    const second = await new ChromeStorageAdapter().commitIntent({
      path: "globalOn",
      value: true,
      updatedAt: 100,
    });
    expect(second.intentCommitted).toBe(true);
    expect(second.settings.updatedAt).toBe(102);
    const third = await h.consumer.commitIntent({
      path: "services.youtube",
      value: false,
      updatedAt: 100,
    });
    expect(third.intentCommitted).toBe(true);
    expect(h.saved()).toEqual({
      ...before,
      settings: { ...before.settings, globalOn: true, updatedAt: 103 },
    });
    expect(h.local.set).toHaveBeenCalledTimes(3);
  });

  it("returns a false receipt and preserves every durable byte for a schema-1 no-op", async () => {
    const before = retainedRecord();
    const h = browser(before);
    const bytes = JSON.stringify(h.saved());
    const reply = await h.consumer.commitIntent({
      path: "globalOn",
      value: false,
      updatedAt: 200,
    });
    expect(reply.intentCommitted).toBe(false);
    expect(reply.settings.updatedAt).toBe(100);
    expect(JSON.stringify(h.saved())).toBe(bytes);
    expect(h.local.set).not.toHaveBeenCalled();
  });

  it("acknowledges only persistence and returns false for an overlapping same-target request", async () => {
    const before = retainedRecord();
    const h = browser(before);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persist = h.local.set.getMockImplementation()!;
    h.local.set.mockImplementationOnce(async (values) => {
      await gate;
      await persist(values);
    });
    const replies: boolean[] = [];
    const edit: SettingsIntent = {
      path: "globalOn",
      value: true,
      updatedAt: 100,
    };
    const first = h.consumer.commitIntent(edit).then((r) => {
      replies.push(r.intentCommitted === true);
      return r;
    });
    const duplicate = h.consumer.commitIntent(edit).then((r) => {
      replies.push(r.intentCommitted === true);
      return r;
    });
    const pending = Promise.all([first, duplicate]);
    // A weakened authority must fail assertions, without leaking rejected test promises.
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(h.local.set).toHaveBeenCalledTimes(1));
      expect(h.saved()).toEqual(before);
      expect(replies).toEqual([]);
    } finally {
      release();
      await pending.catch(() => undefined);
    }
    const outcomes = await pending;
    expect(outcomes.map((r) => r.intentCommitted)).toEqual([true, false]);
    expect(replies).toEqual([true, false]);
    expect(h.local.set).toHaveBeenCalledTimes(1);
    expect(h.saved()).toEqual({
      ...before,
      settings: { ...before.settings, globalOn: true, updatedAt: 101 },
    });
  });

  it("reports a refused persistence as unavailable and leaves the saved record unchanged", async () => {
    const before = retainedRecord();
    const h = browser(before);
    h.local.set.mockRejectedValueOnce(
      new Error("Synthetic persistence refused"),
    );
    await expect(
      h.consumer.commitIntent({
        path: "globalOn",
        value: true,
        updatedAt: 101,
      }),
    ).rejects.toThrow("authority-unavailable");
    expect(h.local.set).toHaveBeenCalledTimes(1);
    expect(h.saved()).toEqual(before);
    const retry = await h.consumer.commitIntent({
      path: "services.youtube",
      value: true,
      updatedAt: 50,
    });
    expect(retry.intentCommitted).toBe(true);
    expect(h.saved()).toEqual({
      ...before,
      settings: {
        ...before.settings,
        services: { ...before.settings.services, youtube: true },
        updatedAt: 101,
      },
    });
  });

  it.each(["globalOn", "services.youtube"] as const)(
    "preserves unversioned legacy %s behavior",
    async (path) => {
      const before = retainedRecord(false);
      const h = browser(before);
      expect(
        (await h.consumer.commitIntent({ path, value: true, updatedAt: 200 }))
          .intentCommitted,
      ).toBe(true);
      expect(h.local.set).toHaveBeenCalledTimes(1);
      expect(h.saved()).not.toHaveProperty("settings.schemaVersion");
      expect(h.saved()).toMatchObject({
        syncMetadata: before.syncMetadata,
        syncEpoch: before.syncEpoch,
        futureRoot: before.futureRoot,
      });
    },
  );

  it.each([undefined, null, "1", true, 0, 3])(
    "retains unsupported explicit schema %s with zero writes",
    async (schemaVersion) => {
      const before = retainedRecord();
      const raw = {
        ...before,
        settings: { ...before.settings, schemaVersion },
      };
      const h = browser(raw);
      await expect(
        h.consumer.commitIntent({
          path: "globalOn",
          value: true,
          updatedAt: 200,
        }),
      ).rejects.toThrow("authority-unavailable");
      expect(h.saved()).toEqual(raw);
      expect(h.local.set).not.toHaveBeenCalled();
    },
  );

  it("retains readable schema-2 settings without atomic provenance and refuses edits", async () => {
    const before = retainedRecord();
    const result = migrateSettingsV2(before.settings, {
      kind: "readable-local",
      provenInitialization: false,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready")
      throw new Error("Modern control fixture was unreadable");
    const raw = { ...before, settings: { ...result.settings, pauses: [] } };
    const h = browser(raw);
    expect((await h.authority.get())?.settings).toHaveProperty(
      "schemaVersion",
      2,
    );
    await expect(
      h.consumer.commitIntent({
        path: "globalOn",
        value: true,
        updatedAt: 200,
      }),
    ).rejects.toThrow("authority-unavailable");
    expect(h.saved()).toEqual(raw);
    expect(h.local.set).not.toHaveBeenCalled();
  });

  it.each([null, "malformed", { settings: { globalOn: false } }])(
    "retains corrupt keyed storage %j without writing",
    async (raw) => {
      const h = browser(raw);
      await expect(
        h.consumer.commitIntent({
          path: "globalOn",
          value: true,
          updatedAt: 200,
        }),
      ).rejects.toThrow("authority-unavailable");
      expect(h.saved()).toEqual(raw);
      expect(h.local.set).not.toHaveBeenCalled();
    },
  );

  it("keeps modern feature intents held for readable schema-1 records", async () => {
    const before = retainedRecord();
    const h = browser(before);
    await expect(
      h.consumer.commitIntent({
        path: "sites.youtube.shorts",
        value: false,
        updatedAt: 200,
      }),
    ).rejects.toThrow("authority-unavailable");
    expect(h.saved()).toEqual(before);
    expect(h.local.set).not.toHaveBeenCalled();
  });
});
