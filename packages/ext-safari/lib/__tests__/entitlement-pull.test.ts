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

  it("a failing purge write does NOT record the new id — nothing else is written", async () => {
    // Recording the id first would mark the generation handled while the stale grant survives,
    // forfeiting the purge forever. Leave the marker untouched so the next pull retries.
    const s = { set: vi.fn().mockRejectedValue(new Error("storage broke")) };
    const generations = fakeGenerations("A");
    await expect(
      applyInstallGeneration("changed", "B", { sink: s, generations }),
    ).resolves.toBe(false);
    expect(generations.set).not.toHaveBeenCalled();
    expect(generations.stored).toBe("A");
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

  it("an unreadable marker store is 'unknown': no purge, NO marker write, record still applies", async () => {
    // A failed read must not masquerade as "never recorded an id" — adopting here would overwrite
    // the REAL stored id with the reply's. Strict no-op on the generation lane; the entitlement
    // record still lands.
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
    expect(writes).toEqual([[true, NOW - 1]]); // apply only — no purge write
    expect(generations.set).not.toHaveBeenCalled();
  });

  it("changed with failing purge retries on the next pull", async () => {
    // First pull: the purge write rejects, so the marker must stay at "A". Second pull (storage
    // healthy again): "changed" re-resolves, the purge lands, and the marker advances.
    const writes: Array<[boolean, number | undefined]> = [];
    let failNextSet = true;
    const sink: EntitlementSink = {
      set: vi.fn(async (entitled: boolean, updatedAt?: number) => {
        if (failNextSet) {
          failNextSet = false;
          throw new Error("storage broke");
        }
        writes.push([entitled, updatedAt]);
      }),
    };
    const generations = fakeGenerations("A");
    const pull = createEntitlementPull({
      send: async () => markerOnlyReply("B"),
      sink,
      generations,
      now: () => NOW,
    });
    await pull();
    expect(writes).toEqual([]); // purge failed — nothing landed
    expect(generations.stored).toBe("A"); // marker unchanged, so the next pull retries
    await pull();
    expect(writes).toEqual([[false, NOW]]); // purge landed
    expect(generations.stored).toBe("B"); // marker advances only after the purge succeeds
  });

  it("a rejecting sink.set on the apply path does not reject the pull promise", async () => {
    // Both production call sites are `void pull()` with no catch — a storage failure applying the
    // record must be swallowed, not surface as an unhandled rejection.
    const sink: EntitlementSink = {
      set: vi.fn().mockRejectedValue(new Error("storage broke")),
    };
    const generations = fakeGenerations("A");
    const pull = createEntitlementPull({
      send: async () => reply(true, NOW - 1, "A"), // same id — apply path only, no purge
      sink,
      generations,
      now: () => NOW,
    });
    await expect(pull()).resolves.toBeUndefined();
    expect(sink.set).toHaveBeenCalledTimes(1);
  });
});

describe("envelope tolerance — the four-key purchase-first envelope (plan 2026-07-15-001, U6)", () => {
  // The native stamp gained a `source` field ("receipt" | "server", ADR 0003). The parser must
  // treat it as informational: identical behavior with it, without it (legacy build-3 stamps),
  // and with any future unknown keys. These pins make that tolerance load-bearing.
  it("parses an envelope carrying source identically to the legacy shape", () => {
    const withSource = parseNativeEntitlement({
      entitlement: JSON.stringify({
        entitled: true,
        updatedAt: 7,
        installId: "gen-1",
        source: "receipt",
      }),
    });
    const legacy = parseNativeEntitlement({
      entitlement: JSON.stringify({ entitled: true, updatedAt: 7, installId: "gen-1" }),
    });
    expect(withSource.record).toEqual(legacy.record);
    expect(withSource.installId).toBe(legacy.installId);
  });

  it("a marker-only envelope with an explicit-null source stays a no-signal record", () => {
    const parsed = parseNativeEntitlement({
      entitlement: JSON.stringify({
        entitled: null,
        updatedAt: null,
        installId: "gen-1",
        source: null,
      }),
    });
    expect(parsed.record).toBeNull();
    expect(parsed.installId).toBe("gen-1");
  });

  it("unknown future keys are ignored, not a parse failure", () => {
    const parsed = parseNativeEntitlement({
      entitlement: JSON.stringify({
        entitled: false,
        updatedAt: 9,
        installId: "gen-1",
        source: "server",
        someFutureKey: { nested: true },
      }),
    });
    expect(parsed.record).toEqual({ entitled: false, updatedAt: 9 });
  });
});
