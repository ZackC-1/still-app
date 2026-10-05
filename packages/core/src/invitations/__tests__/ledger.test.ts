import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createInvitationLedger, INVITATION_RULES, parseInvitationLedger, recordInvitationDirectControl, recordInvitationOpening,
  recordInvitationPurchase, type InvitationLedger,
} from "../ledger.js";
import { arbitrateInvitation, commitInvitation, reserveInvitation, type InvitationContext } from "../arbiter.js";
import {
  InMemoryInvitationLedgerPort, InvitationLedgerStore, serializedInvitationLedgerPort, INVITATION_LEDGER_KEY, type InvitationLedgerPort,
} from "../storage.js";

const T0 = 1_790_000_000_000, DAY = 86_400_000, D0 = Math.floor(T0 / DAY);
const ctx = (opening: string, nowMs: number, extra: Partial<InvitationContext> = {}): InvitationContext =>
  ({ opening, nowMs, syncApplicable: true, linkApplicable: true, suppressed: null, ...extra });
const fresh = (anchor: number | null = T0) => createInvitationLedger("install-a", anchor)!;
const open = (l: InvitationLedger, opening: string, nowMs: number, localDay: number | null) =>
  recordInvitationOpening(l, { opening, ordinary: true, nowMs, localDay });
const direct = { control: "site", source: "direct", outcome: "succeeded", signedIn: false, ready: true } as const;
function threeDays(anchor: number | null = T0): InvitationLedger {
  let l = fresh(anchor);
  for (let i = 0; i < 3; i++) l = open(l, `o${i + 1}`, T0 + i * DAY, D0 + i);
  return l;
}

describe("rating boundaries", () => {
  it("the seven-day boundary is exactly 604,800,000 ms", () => {
    expect(INVITATION_RULES.ratingMinimumAgeMs).toBe(604_800_000);
    const l = open(threeDays(), "o4", T0 + 3 * DAY, D0 + 3);
    expect(arbitrateInvitation(l, ctx("o4", T0 + 604_799_999)).kind).toBeNull();
    expect(arbitrateInvitation(l, ctx("o4", T0 + 604_800_000)).kind).toBe("rating");
  });
  it("the opening that earns day three only establishes readiness; a later opening may show", () => {
    const earning = threeDays(T0 - 30 * DAY);
    expect(earning.distinctDays).toBe(3);
    expect(arbitrateInvitation(earning, ctx("o3", T0 + 2 * DAY))).toEqual({ kind: null, reason: "none" });
    const later = open(earning, "o4", T0 + 2 * DAY + 1, D0 + 2);
    expect(arbitrateInvitation(later, ctx("o4", T0 + 2 * DAY + 1)).kind).toBe("rating");
  });
  it("a repeated, earlier or unreadable day never earns a count, and the ordinal never decreases", () => {
    let l = open(fresh(), "o1", T0, D0 + 5);
    l = open(l, "o2", T0 + 1, D0 + 5);
    l = open(l, "o3", T0 + 2, D0 + 4);
    l = open(l, "o4", T0 + 3, null);
    expect([l.dayOrdinal, l.distinctDays]).toEqual([D0 + 5, 1]);
  });
  it("a clock rollback pauses every card and resets nothing", () => {
    let l = open(threeDays(), "o4", T0 + 8 * DAY, D0 + 8);
    const before = { ...l };
    l = open(l, "o5", T0 + 3 * DAY, D0 + 3);
    expect(arbitrateInvitation(l, ctx("o5", T0 + 3 * DAY))).toEqual({ kind: null, reason: "clock-paused" });
    expect({ ...l, lastOpening: before.lastOpening }).toEqual(before);
    l = open(l, "o6", T0 + 8 * DAY, D0 + 8);
    expect(arbitrateInvitation(l, ctx("o6", T0 + 8 * DAY)).kind).toBe("rating");
  });
  it("a future anchor pauses rating until real age passes", () => {
    const l = open(threeDays(T0 + 10 * DAY), "o4", T0 + 16 * DAY, D0 + 16);
    expect(arbitrateInvitation(l, ctx("o4", T0 + 16 * DAY)).kind).toBeNull();
    expect(arbitrateInvitation(l, ctx("o4", T0 + 17 * DAY)).kind).toBe("rating");
  });
});

describe("sync and link invitations", () => {
  it("counters saturate: milestones and days stop at three", () => {
    let l = open(fresh(), "o1", T0, D0);
    for (let i = 0; i < 9; i++) l = recordInvitationDirectControl(l, direct);
    expect(l.milestones).toBe(3);
    for (let i = 1; i < 9; i++) l = open(l, `d${i}`, T0 + i * DAY, D0 + i);
    expect(l.distinctDays).toBe(3);
    expect(parseInvitationLedger(JSON.parse(JSON.stringify(l)))).toEqual(l);
  });
  it("sync and link are at least 168 hours apart, and at most two are ever shown", () => {
    expect(INVITATION_RULES.invitationSpacingMs).toBe(168 * 60 * 60 * 1000);
    let l = open(fresh(), "o1", T0, D0);
    l = recordInvitationPurchase(l, { source: "new-apple-purchase", verified: true, unlinked: true });
    for (let i = 0; i < 3; i++) l = recordInvitationDirectControl(l, direct);
    l = open(l, "o2", T0, D0);
    const r = reserveInvitation(l, "link", ctx("o2", T0));
    if (!r.ok) throw new Error("reserve");
    l = commitInvitation(r.ledger, r.reservation, T0)!;
    const spacing = 168 * 60 * 60 * 1000;
    l = open(l, "o3", T0 + spacing - 1, D0 + 6);
    expect(arbitrateInvitation(l, ctx("o3", T0 + spacing - 1)).kind).toBeNull();
    l = open(l, "o4", T0 + spacing, D0 + 7);
    const s = reserveInvitation(l, "sync", ctx("o4", T0 + spacing));
    if (!s.ok) throw new Error("reserve sync");
    l = commitInvitation(s.ledger, s.reservation, T0 + spacing)!;
    expect(l.shown).toBe(INVITATION_RULES.maxInvitations);
    expect(parseInvitationLedger({ ...l, shown: 3 })).toBeNull();
  });
  it("restore, complimentary, browser purchase, second device and synced changes never count", () => {
    let l = open(fresh(), "o1", T0, D0);
    for (const source of ["sync-applied", "restore", "complimentary", "browser-purchase", "second-device", "cascade", "read", "unknown"] as const) {
      l = recordInvitationDirectControl(l, { ...direct, source });
      l = recordInvitationDirectControl(l, { ...direct, source });
      l = recordInvitationDirectControl(l, { ...direct, source });
    }
    for (const source of ["restore", "complimentary", "browser-purchase", "second-device", "sync-applied", "unknown"] as const)
      l = recordInvitationPurchase(l, { source, verified: true, unlinked: true });
    expect([l.milestones, l.sync, l.link]).toEqual([0, "idle", "idle"]);
  });
});

describe("parallel hosts: every interleaving of two hosts consumes exactly once", () => {
  it("all 20 orderings of open, reserve and commit on two hosts", () => {
    let base = open(fresh(), "o1", T0, D0);
    base = recordInvitationPurchase(base, { source: "new-apple-purchase", verified: true, unlinked: true });
    const orders: string[][] = [];
    const walk = (a: number, b: number, acc: string[]) => {
      if (a === 3 && b === 3) { orders.push(acc); return; }
      if (a < 3) walk(a + 1, b, [...acc, "a"]);
      if (b < 3) walk(a, b + 1, [...acc, "b"]);
    };
    walk(0, 0, []);
    expect(orders).toHaveLength(20);
    for (const order of orders) {
      let l = base;
      const step = { a: 0, b: 0 }, held: Record<string, ReturnType<typeof reserveInvitation> | null> = { a: null, b: null };
      let commits = 0;
      for (const host of order as ("a" | "b")[]) {
        const now = T0 + 1;
        if (step[host] === 0) l = open(l, host, now, D0);
        else if (step[host] === 1) { const r = reserveInvitation(l, "link", ctx(host, now)); held[host] = r; if (r.ok) l = r.ledger; }
        else { const r = held[host]; const next = r?.ok ? commitInvitation(l, r.reservation, now) : null; if (next) { l = next; commits++; } }
        step[host]++;
      }
      expect(commits, order.join("")).toBe(1);
      expect(l.shown).toBe(1);
    }
  });
});

describe("storage port", () => {
  async function dueLinkStore<P extends InvitationLedgerPort>(port: P) {
    const store = new InvitationLedgerStore(port);
    await store.ensure("install-a", T0);
    await store.recordOpening({ opening: "o1", ordinary: true, nowMs: T0, localDay: D0 });
    await store.recordPurchase({ source: "new-apple-purchase", verified: true, unlinked: true });
    return { port, store };
  }
  it("parallel hosts consume once (generation fence)", async () => {
    const { port } = await dueLinkStore(new InMemoryInvitationLedgerPort());
    const a = new InvitationLedgerStore(port), b = new InvitationLedgerStore(port);
    // Two hosts open at once; only the most recent ordinary opening may be offered a card.
    await Promise.all([
      a.recordOpening({ opening: "a", ordinary: true, nowMs: T0 + 1, localDay: D0 }),
      b.recordOpening({ opening: "b", ordinary: true, nowMs: T0 + 1, localDay: D0 }),
    ]);
    const [ra, rb] = await Promise.all([a.reserve("link", ctx("a", T0 + 1)), b.reserve("link", ctx("b", T0 + 1))]);
    const [ca, cb] = await Promise.all([ra ? a.commit(ra, T0 + 2) : false, rb ? b.commit(rb, T0 + 2) : false]);
    expect([ca, cb].filter(Boolean)).toHaveLength(1);
    expect(parseInvitationLedger(port.value)?.shown).toBe(1);
  });
  it("a host that reserved before another opening reclaimed it cannot commit", async () => {
    const { port, store } = await dueLinkStore(new InMemoryInvitationLedgerPort());
    await store.recordOpening({ opening: "a", ordinary: true, nowMs: T0 + 1, localDay: D0 });
    const ra = await store.reserve("link", ctx("a", T0 + 1));
    expect(ra).not.toBeNull();
    const other = new InvitationLedgerStore(port);
    await other.recordOpening({ opening: "b", ordinary: true, nowMs: T0 + 2, localDay: D0 });
    expect(await store.commit(ra!, T0 + 3)).toBe(false);
    const rb = await other.reserve("link", ctx("b", T0 + 3));
    expect(await other.commit(rb!, T0 + 3)).toBe(true);
    expect(parseInvitationLedger(port.value)).toMatchObject({ shown: 1, link: "consumed", lastCardOpening: "b" });
  });
  it("an unreadable slot is never overwritten or reset, and never offers a card", async () => {
    const corrupt = { schema: 1, milestones: 99 };
    const port = new InMemoryInvitationLedgerPort(corrupt);
    const store = new InvitationLedgerStore(port);
    expect(await store.ensure("install-a", T0)).toBe("unreadable");
    expect(await store.recordOpening({ opening: "o1", ordinary: true, nowMs: T0, localDay: D0 })).toBe("unreadable");
    expect(await store.arbitrate(ctx("o1", T0))).toEqual({ kind: null, reason: "none" });
    expect(await store.reserve("rating", ctx("o1", T0))).toBeNull();
    expect(port.value).toEqual(corrupt);
  });
  it("an absent slot is only created by ensure, and ensure never replaces an existing ledger", async () => {
    const port = new InMemoryInvitationLedgerPort();
    const store = new InvitationLedgerStore(port);
    expect(await store.recordOpening({ opening: "o1", ordinary: true, nowMs: T0, localDay: D0 })).toBe("absent");
    expect(port.value).toBeUndefined();
    expect(await store.ensure("install-a", T0)).toBe("ready");
    expect(await store.ensure("install-b", T0 + DAY)).toBe("ready");
    expect(parseInvitationLedger(port.value)).toMatchObject({ installation: "install-a", anchorMs: T0 });
  });
  it("composes an existing serialized authority with a local area under the local-only key", async () => {
    const area = new Map<string, unknown>();
    let tail: Promise<unknown> = Promise.resolve();
    const serialize = <T,>(body: () => Promise<T>): Promise<T> => { const run = tail.then(body, body); tail = run.catch(() => undefined); return run; };
    const port = serializedInvitationLedgerPort({
      serialize, read: async () => area.get(INVITATION_LEDGER_KEY), write: async v => { area.set(INVITATION_LEDGER_KEY, v); },
    });
    const { store } = await dueLinkStore(port);
    await store.recordOpening({ opening: "o2", ordinary: true, nowMs: T0 + 1, localDay: D0 });
    expect(await store.arbitrate(ctx("o2", T0 + 1))).toEqual({ kind: "link", reason: "card" });
    expect([...area.keys()]).toEqual(["still:invitationLedger"]);
  });
});

describe("privacy: the invitation module has no telemetry, network, notification or background path", () => {
  it("source files reference none of them", () => {
    const dir = join(__dirname, "..");
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const sources = readdirSync(dir).filter(f => f.endsWith(".ts")).map(f => code(readFileSync(join(dir, f), "utf8")));
    expect(sources.length).toBeGreaterThanOrEqual(5);
    for (const text of sources) {
      for (const forbidden of [/analytics/i, /posthog/i, /\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /notifications/, /\balarms\b/, /setBadge/, /storage\.sync/, /runtime\.sendMessage/])
        expect(text).not.toMatch(forbidden);
    }
  });
});
