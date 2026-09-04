import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  ensureOriginalInstall,
  parseOriginalInstall,
  type OriginalInstallRecord,
  type OriginalInstallStore,
} from "../original-install.js";

// The record cannot be recreated once it is wrong, so the cases below are about the two ways it
// could be: writing it more than once, and failing to read one that already exists.

function store(initial: unknown = null) {
  let value = initial;
  const writes: OriginalInstallRecord[] = [];
  const slot: OriginalInstallStore = {
    get: async () => value,
    set: async (record) => {
      writes.push(record);
      value = record;
    },
  };
  return { slot, writes, read: () => value };
}

describe("the browser install record", () => {
  it("writes the date and version on a first ever start", async () => {
    const s = store();
    const record = await ensureOriginalInstall({
      store: s.slot,
      now: () => 1_700_000_000_000,
      appVersion: "2.0.0",
    });
    expect(record).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      firstRecordedAt: 1_700_000_000_000,
      firstRecordedAppVersion: "2.0.0",
    });
    expect(s.writes).toHaveLength(1);
  });

  it("never moves the date forward on a later start, an update, or a worker wake", async () => {
    const s = store();
    await ensureOriginalInstall({ store: s.slot, now: () => 1_000, appVersion: "2.0.0" });
    for (const [now, version] of [
      [2_000, "2.0.0"], // an ordinary restart
      [3_000, "2.1.0"], // an update
      [4_000, "3.0.0"], // a much later update
    ] as const) {
      const again = await ensureOriginalInstall({ store: s.slot, now: () => now, appVersion: version });
      expect(again?.firstRecordedAt).toBe(1_000);
      expect(again?.firstRecordedAppVersion).toBe("2.0.0");
    }
    expect(s.writes).toHaveLength(1); // exactly one write, ever
  });

  it("keeps a record written by a later build, ignoring fields it has never heard of", async () => {
    const s = store({
      schemaVersion: 7,
      firstRecordedAt: 500,
      firstRecordedAppVersion: "9.9.9",
      somethingAddedLater: { nested: true },
    });
    const record = await ensureOriginalInstall({ store: s.slot, now: () => 9_000, appVersion: "2.0.0" });
    expect(record).toEqual({
      schemaVersion: 7,
      firstRecordedAt: 500,
      firstRecordedAppVersion: "9.9.9",
    });
    expect(s.writes).toHaveLength(0);
  });

  it("treats a record with no schema version as version one rather than as garbage", () => {
    expect(parseOriginalInstall({ firstRecordedAt: 5, firstRecordedAppVersion: "1.0.4" })).toEqual({
      schemaVersion: 1,
      firstRecordedAt: 5,
      firstRecordedAppVersion: "1.0.4",
    });
  });

  it("reads anything without a usable date or version as no record at all", () => {
    for (const value of [
      null,
      undefined,
      "a string",
      [],
      {},
      { firstRecordedAt: "yesterday", firstRecordedAppVersion: "2.0.0" },
      { firstRecordedAt: Number.NaN, firstRecordedAppVersion: "2.0.0" },
      { firstRecordedAt: 5 },
      { firstRecordedAt: 5, firstRecordedAppVersion: "" },
    ]) {
      expect(parseOriginalInstall(value)).toBeNull();
    }
  });

  it("survives a storage failure instead of taking the background start down with it", async () => {
    const failing: OriginalInstallStore = {
      get: async () => {
        throw new Error("storage unavailable");
      },
      set: async () => {},
    };
    await expect(
      ensureOriginalInstall({ store: failing, now: () => 1, appVersion: "2.0.0" }),
    ).resolves.toBeNull();
  });
});
