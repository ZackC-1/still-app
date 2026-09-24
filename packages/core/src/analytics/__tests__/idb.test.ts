import { describe, it, expect } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createIndexedDbKeyValue } from "../idb.js";

describe("createIndexedDbKeyValue", () => {
  it("persists values across instances on the same database", async () => {
    const factory = new IDBFactory();
    const first = createIndexedDbKeyValue("t", factory);
    await first.set("q", [{ event: "active" }]);
    const second = createIndexedDbKeyValue("t", factory);
    expect(await second.get("q")).toEqual([{ event: "active" }]);
    expect(await second.get("missing")).toBeNull();
  });

  it("falls back to memory when IndexedDB is unavailable", async () => {
    const kv = createIndexedDbKeyValue("t", undefined);
    await kv.set("q", [1]);
    expect(await kv.get("q")).toEqual([1]);
  });

  it("falls back to memory when opening fails", async () => {
    const broken = { open: () => { throw new Error("denied"); } } as unknown as IDBFactory;
    const kv = createIndexedDbKeyValue("t", broken);
    await kv.set("q", "x");
    expect(await kv.get("q")).toBe("x");
  });
});
