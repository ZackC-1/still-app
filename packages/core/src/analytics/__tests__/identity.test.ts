import { describe, it, expect } from "vitest";
import { ANCHOR_KEY, INSTALL_KEY, resolveAnalyticsIdentity, type AnalyticsKeyValue } from "../identity.js";

function memory(initial: Record<string, unknown> = {}): AnalyticsKeyValue & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: async (k) => data[k],
    set: async (k, v) => void (data[k] = v),
  };
}

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

describe("resolveAnalyticsIdentity", () => {
  it("creates ids on first start and shares a new anchor", async () => {
    const local = memory();
    const shared = memory();
    const id = await resolveAnalyticsIdentity({ local, shared, uuid });
    expect(id.created).toBe(true);
    expect(id.returning).toBe(false);
    expect(shared.data[ANCHOR_KEY]).toBe(id.anchorId);
    expect(local.data[INSTALL_KEY]).toEqual({ installId: id.installId, anchorId: id.anchorId });
  });

  it("returns the stored ids on later starts", async () => {
    const local = memory();
    const first = await resolveAnalyticsIdentity({ local, shared: memory(), uuid });
    const again = await resolveAnalyticsIdentity({ local, shared: memory(), uuid });
    expect(again).toEqual({ installId: first.installId, anchorId: first.anchorId, created: false, returning: false });
  });

  it("a new install that finds this person's anchor is returning, under the same anchor", async () => {
    const shared = memory();
    const phone = await resolveAnalyticsIdentity({ local: memory(), shared, uuid });
    const mac = await resolveAnalyticsIdentity({ local: memory(), shared, uuid });
    expect(mac.returning).toBe(true);
    expect(mac.anchorId).toBe(phone.anchorId);
    expect(mac.installId).not.toBe(phone.installId);
  });

  it("without a shared store the anchor is the install id", async () => {
    const id = await resolveAnalyticsIdentity({ local: memory(), uuid });
    expect(id.anchorId).toBe(id.installId);
    expect(id.returning).toBe(false);
  });

  it("an unavailable shared store never throws", async () => {
    const broken: AnalyticsKeyValue = {
      get: async () => { throw new Error("iCloud unavailable"); },
      set: async () => { throw new Error("iCloud unavailable"); },
    };
    const id = await resolveAnalyticsIdentity({ local: memory(), shared: broken, uuid });
    expect(id.created).toBe(true);
    expect(id.returning).toBe(false);
  });

  it("ignores a corrupt shared anchor", async () => {
    const id = await resolveAnalyticsIdentity({ local: memory(), shared: memory({ [ANCHOR_KEY]: "https://x" }), uuid });
    expect(id.returning).toBe(false);
    expect(id.anchorId).not.toBe("https://x");
  });
});

describe("late shared anchors", () => {
  it("adopts an anchor that arrives after this install made its own, and names the old one to merge", async () => {
    const local = memory();
    const shared = memory();
    const first = await resolveAnalyticsIdentity({ local, shared: memory(), uuid }); // sync not there yet
    shared.data[ANCHOR_KEY] = "99999999-9999-4999-8999-999999999999";
    const later = await resolveAnalyticsIdentity({ local, shared, uuid });
    expect(later.anchorId).toBe("99999999-9999-4999-8999-999999999999");
    expect(later.aliasOf).toBe(first.anchorId);
    expect(later.installId).toBe(first.installId);
    // Kept across restarts until sent; the client's marker makes sure it goes out once.
    const again = await resolveAnalyticsIdentity({ local, shared, uuid });
    expect(again.aliasOf).toBe(first.anchorId);
  });
});

describe("waiting for sync on a fresh install", () => {
  it("an anchor that arrives during the grace period makes the install returning", async () => {
    const shared = memory();
    const id = await resolveAnalyticsIdentity({
      local: memory(), shared, uuid, sharedGraceMs: 3_000,
      sleep: async () => { shared.data[ANCHOR_KEY] = "99999999-9999-4999-8999-999999999999"; },
    });
    expect(id.returning).toBe(true);
    expect(id.anchorId).toBe("99999999-9999-4999-8999-999999999999");
  });

  it("no anchor after the grace period: a new person", async () => {
    const id = await resolveAnalyticsIdentity({ local: memory(), shared: memory(), uuid, sharedGraceMs: 3_000, sleep: async () => {} });
    expect(id.returning).toBe(false);
  });
});

describe("no alias chains", () => {
  it("adopts a synced anchor at most once, so no id is aliased after being an alias destination", async () => {
    const local = memory();
    const shared = memory();
    await resolveAnalyticsIdentity({ local, shared: memory(), uuid });
    shared.data[ANCHOR_KEY] = "99999999-9999-4999-8999-999999999999";
    const adopted = await resolveAnalyticsIdentity({ local, shared, uuid });
    shared.data[ANCHOR_KEY] = "88888888-8888-4888-8888-888888888888"; // another device raced later
    const later = await resolveAnalyticsIdentity({ local, shared, uuid });
    expect(later.anchorId).toBe(adopted.anchorId);
    expect(later.aliasOf).toBe(adopted.aliasOf);
  });
});
