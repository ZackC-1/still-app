import { describe, expect, it, vi } from "vitest";
import {
  applyInstallGeneration,
  applyNativeEntitlement,
  createEntitlementPull,
  parseNativeEntitlement,
  resolveInstallGeneration,
  type EntitlementSink,
  type InstallGenerationStore,
} from "../entitlement-pull.js";

const record = (entitled: boolean, updatedAt: number) => ({ entitled, updatedAt });
const reply = (entitled: boolean, updatedAt: number, installId?: string) => ({
  entitlement: JSON.stringify(
    installId === undefined ? { entitled, updatedAt } : { entitled, updatedAt, installId },
  ),
});
const markerOnlyReply = (installId: string | null) => ({
  entitlement: JSON.stringify({ entitled: null, updatedAt: null, installId }),
});

function fakeGenerations(initial: string | null = null): InstallGenerationStore & { stored: string | null } {
  const store = {
    stored: initial,
    get: vi.fn(async () => store.stored),
    set: vi.fn(async (id: string) => {
      store.stored = id;
    }),
  };
  return store;
}

describe("parseNativeEntitlement", () => {
  it("parses the full envelope: record plus install id", () => {
    expect(parseNativeEntitlement(reply(true, 42, "B"))).toEqual({
      record: record(true, 42),
      installId: "B",
    });
  });

  it("parses a legacy record without installId (old app build)", () => {
    expect(parseNativeEntitlement(reply(false, 7))).toEqual({
      record: record(false, 7),
      installId: null,
    });
  });

  it("parses the marker-only envelope (post-reinstall: marker, no record)", () => {
    expect(parseNativeEntitlement(markerOnlyReply("B"))).toEqual({ record: null, installId: "B" });
  });

  it("yields both-null for the legacy empty reply and the all-null envelope", () => {
    expect(parseNativeEntitlement({ entitlement: "" })).toEqual({ record: null, installId: null });
    expect(parseNativeEntitlement(markerOnlyReply(null))).toEqual({ record: null, installId: null });
  });

  it("yields both-null for missing/malformed envelopes and payloads", () => {
    const nothing = { record: null, installId: null };
    expect(parseNativeEntitlement(null)).toEqual(nothing);
    expect(parseNativeEntitlement(undefined)).toEqual(nothing);
    expect(parseNativeEntitlement("json string")).toEqual(nothing);
    expect(parseNativeEntitlement({ settings: "{}" })).toEqual(nothing); // settings lane
    expect(parseNativeEntitlement({ entitlement: "{not json" })).toEqual(nothing);
    expect(parseNativeEntitlement({ entitlement: '"just a string"' })).toEqual(nothing);
    expect(parseNativeEntitlement({ entitlement: '{"installId":""}' })).toEqual(nothing);
  });

  it("drops a malformed record but keeps a valid install id (and vice versa)", () => {
    expect(parseNativeEntitlement({ entitlement: '{"entitled":"yes","updatedAt":1,"installId":"B"}' }))
      .toEqual({ record: null, installId: "B" });
    expect(parseNativeEntitlement({ entitlement: '{"entitled":true,"installId":null}' }))
      .toEqual({ record: null, installId: null }); // no stamp → no record
    expect(parseNativeEntitlement({ entitlement: '{"entitled":true,"updatedAt":1,"installId":7}' }))
      .toEqual({ record: record(true, 1), installId: null }); // non-string id → unknown
  });
});

describe("resolveInstallGeneration", () => {
  it("covers the outcome matrix exactly", () => {
    expect(resolveInstallGeneration("A", null)).toBe("unknown");
    expect(resolveInstallGeneration(null, null)).toBe("unknown");
    expect(resolveInstallGeneration(null, "B")).toBe("adopt");
    expect(resolveInstallGeneration("B", "B")).toBe("same");
    expect(resolveInstallGeneration("A", "B")).toBe("changed");
  });
});

describe("applyInstallGeneration", () => {
  const sink = () => ({ set: vi.fn().mockResolvedValue(undefined) }) satisfies EntitlementSink;

  it("'changed' purges with an explicit entitled:false write, then records the new id", async () => {
    const s = sink();
    const generations = fakeGenerations("A");
    await expect(
      applyInstallGeneration("changed", "B", { sink: s, generations, now: () => 99 }),
    ).resolves.toBe(true);
    expect(s.set).toHaveBeenCalledWith(false, 99); // explicit false — never a key removal
    expect(generations.set).toHaveBeenCalledWith("B");
  });

  it("'adopt' records the id WITHOUT touching entitlement (upgrade path, R3)", async () => {
    const s = sink();
    const generations = fakeGenerations(null);
    await expect(
      applyInstallGeneration("adopt", "B", { sink: s, generations }),
    ).resolves.toBe(false);
    expect(s.set).not.toHaveBeenCalled();
    expect(generations.set).toHaveBeenCalledWith("B");
  });

  it("'same' and 'unknown' write nothing at all (R2)", async () => {
    const s = sink();
    const generations = fakeGenerations("A");
    await applyInstallGeneration("same", "A", { sink: s, generations });
    await applyInstallGeneration("unknown", null, { sink: s, generations });
    await applyInstallGeneration("unknown", null, { sink: s, generations }); // twice in a row
    expect(s.set).not.toHaveBeenCalled();
    expect(generations.set).not.toHaveBeenCalled();
  });

  it("a failing purge write still records the new id (swallow-and-continue)", async () => {
    const s = { set: vi.fn().mockRejectedValue(new Error("storage broke")) };
    const generations = fakeGenerations("A");
    await expect(
      applyInstallGeneration("changed", "B", { sink: s, generations }),
    ).resolves.toBe(true);
    expect(generations.set).toHaveBeenCalledWith("B");
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("applyNativeEntitlement", () => {
  it("writes the record through, preserving the app's server-confirmed updatedAt", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    await expect(applyNativeEntitlement(record(true, 42), { set }, () => 43)).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(true, 42);
  });

  it("writes an explicit revocation (entitled:false)", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    await expect(applyNativeEntitlement(record(false, 9), { set }, () => 10)).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(false, 9);
  });

  it("no-ops on a null record — an unreadable pull never downgrades local storage", async () => {
    const set = vi.fn();
    await expect(applyNativeEntitlement(null, { set })).resolves.toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it("drops an entitled record already past the 30-day TTL — never a live Pro unlock", async () => {
    const set = vi.fn();
    const now = 40 * DAY_MS;
    await expect(applyNativeEntitlement(record(true, now - 31 * DAY_MS), { set }, () => now)).resolves.toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it("still writes an entitled record inside the TTL, and an expired revocation", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const now = 40 * DAY_MS;
    await expect(applyNativeEntitlement(record(true, now - 29 * DAY_MS), { set }, () => now)).resolves.toBe(true);
    // An old entitled:false is not a grant — writing it is safe (free is the default).
    await expect(applyNativeEntitlement(record(false, now - 31 * DAY_MS), { set }, () => now)).resolves.toBe(true);
  });
});

describe("createEntitlementPull", () => {
  const NOW = 10 * DAY_MS;

  function harness(opts: {
    replies: unknown[] | (() => Promise<unknown>);
    storedId?: string | null;
  }) {
    const writes: Array<[boolean, number | undefined]> = [];
    const sink: EntitlementSink = {
      set: vi.fn(async (entitled: boolean, updatedAt?: number) => {
        writes.push([entitled, updatedAt]);
      }),
    };
    const generations = fakeGenerations(opts.storedId ?? null);
    let sends = 0;
    const send =
      typeof opts.replies === "function"
        ? opts.replies
        : async () => {
            sends += 1;
            return (opts.replies as unknown[])[Math.min(sends, (opts.replies as unknown[]).length) - 1];
          };
    const pull = createEntitlementPull({
      send: async () => {
        if (typeof opts.replies === "function") sends += 1;
        return send();
      },
      sink,
      generations,
      now: () => NOW,
    });
    return { pull, sink, generations, writes, sendCount: () => sends };
  }

  it("reinstall flow: purge on 'changed', then the next pull re-applies the app's fresh grant", async () => {
    const h = harness({
      replies: [markerOnlyReply("B"), reply(true, NOW - 1, "B")],
      storedId: "A",
    });
    await h.pull();
    expect(h.writes).toEqual([[false, NOW]]); // purge only — reply carried no record
    await h.pull();
    expect(h.writes).toEqual([
      [false, NOW],
      [true, NOW - 1], // self-healing re-apply on the next pull
    ]);
    expect(h.generations.stored).toBe("B");
  });

  it("combined single-reply case: changed id + fresh entitled:true lands purge THEN apply, final entitled", async () => {
    const h = harness({ replies: [reply(true, NOW - 1, "B")], storedId: "A" });
    await h.pull();
    // Write ORDER is the contract: purge(false) first, apply(true) second — never the reverse.
    expect(h.writes).toEqual([
      [false, NOW],
      [true, NOW - 1],
    ]);
  });

  it("TTL interaction: 'changed' purge stands even when the reply's grant is already expired", async () => {
    const h = harness({ replies: [reply(true, NOW - 31 * DAY_MS, "B")], storedId: "A" });
    await h.pull();
    expect(h.writes).toEqual([[false, NOW]]); // purge landed; the expired grant was rejected
  });

  it("settings toggles are untouched: only the sink and the marker store are written", async () => {
    const h = harness({ replies: [reply(true, NOW - 1, "B")], storedId: "A" });
    await h.pull();
    // The harness exposes exactly the two write surfaces the pull may touch; nothing else exists
    // to write to (R5) — asserted here by the deps contract itself.
    expect(h.generations.set).toHaveBeenCalledTimes(1);
    expect(h.sink.set).toHaveBeenCalledTimes(2);
  });

  it("single-flight: two concurrent invocations share one native round-trip (second awaits the first)", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const h = harness({
      replies: async () => {
        sends += 1;
        await gate;
        return reply(true, NOW - 1, "A");
      },
      storedId: "A",
    });
    const first = h.pull();
    const second = h.pull();
    release(undefined);
    await Promise.all([first, second]);
    expect(sends).toBe(1); // one round-trip for both callers — no interleaved write passes
    expect(h.writes).toEqual([[true, NOW - 1]]);
  });

  it("a pull issued after the first completes performs a fresh round-trip", async () => {
    const h = harness({ replies: [reply(true, NOW - 1, "A"), reply(true, NOW, "A")], storedId: "A" });
    await h.pull();
    await h.pull();
    expect(h.sendCount()).toBe(2);
  });

  it("an unreachable native host is a strict no-op", async () => {
    const h = harness({
      replies: async () => {
        throw new Error("no native host");
      },
    });
    await h.pull();
    expect(h.writes).toEqual([]);
    expect(h.generations.set).not.toHaveBeenCalled();
  });

  it("an unreadable marker store can never cause a purge (worst case: adopt)", async () => {
    const writes: Array<[boolean, number | undefined]> = [];
    const sink: EntitlementSink = {
      set: vi.fn(async (entitled: boolean, updatedAt?: number) => {
        writes.push([entitled, updatedAt]);
      }),
    };
    const generations: InstallGenerationStore = {
      get: vi.fn().mockRejectedValue(new Error("storage broke")),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const pull = createEntitlementPull({
      send: async () => reply(true, NOW - 1, "B"),
      sink,
      generations,
      now: () => NOW,
    });
    await pull();
    expect(writes).toEqual([[true, NOW - 1]]); // no purge — adopt + apply only
    expect(generations.set).toHaveBeenCalledWith("B");
  });
});
