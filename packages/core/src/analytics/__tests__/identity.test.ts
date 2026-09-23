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
