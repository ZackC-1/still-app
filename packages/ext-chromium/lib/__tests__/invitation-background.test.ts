import { describe, expect, it, vi } from "vitest";
import { AtomicSettingsWriter } from "@still/core/storage";
import {
  INVITATION_LEDGER_KEY,
  InvitationLedgerStore,
  createInvitationLedger,
  parseInvitationLedger,
  type InvitationLedger,
} from "../../../core/src/invitations/index.js";
import {
  INVITATION_MESSAGE_KIND,
  SYNC_INVITATION_PARAMETERS,
  chromeInvitationLedgerPort,
  createInvitationHost,
  declaredHostsGranted,
  readInvitationRequest,
  type InvitationReply,
} from "../invitation-background.js";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 5, 12);
const EXTENSION = "extid";
const ORIGIN = "chrome-extension://extid/";

/** A chrome.storage.local stand-in that yields between steps, so unserialized callers interleave. */
function slowArea() {
  const values: Record<string, unknown> = {};
  const tick = () => new Promise<void>(r => setTimeout(r, 0));
  return {
    values,
    get: async (key: string) => { await tick(); return key in values ? { [key]: structuredClone(values[key]) } : {}; },
    set: async (items: Record<string, unknown>) => { await tick(); Object.assign(values, structuredClone(items)); },
  } as unknown as Pick<chrome.storage.LocalStorageArea, "get" | "set"> & { values: Record<string, unknown> };
}

/** The background's one serialized queue: the settings authority's real writer queue. */
const queue = () => {
  const writer = new AtomicSettingsWriter({ get: async () => null, set: vi.fn(), subscribe: () => () => {} });
  return writer.serializeLocalMutation.bind(writer) as <T>(body: () => Promise<T>) => Promise<T>;
};

function harness(overrides: Partial<{ finished: boolean; account: "signed-out" | "signed-in" | "unknown"; signInAvailable: boolean }> = {}) {
  const facts = { finished: true, account: "signed-out" as "signed-out" | "signed-in" | "unknown", signInAvailable: true, now: T0, ...overrides };
  const area = slowArea();
  const serialize = queue();
  let ids = 0;
  const host = createInvitationHost({
    port: chromeInvitationLedgerPort(serialize, area),
    setupFinished: async () => facts.finished,
    account: async () => facts.account,
    signInAvailable: facts.signInAvailable,
    now: () => facts.now,
    newInstallationId: () => `install-${++ids}`,
  });
  /** A page context: popup or options. Each talks to the same background listener. */
  const page = (url: string, id = EXTENSION) => {
    const listener = host.listener(EXTENSION, ORIGIN);
    return (message: unknown): Promise<InvitationReply | undefined> =>
      new Promise(resolve => {
        const handled = listener(message, { id, url } as chrome.runtime.MessageSender, resolve as (v: unknown) => void);
        if (!handled) resolve(undefined);
      });
  };
  const ledger = () => parseInvitationLedger(area.values[INVITATION_LEDGER_KEY]);
  return { facts, area, serialize, host, page, ledger, popup: page(`${ORIGIN}popup.html`), options: page(`${ORIGIN}options.html`) };
}
type H = ReturnType<typeof harness>;
const present = (h: H, opening: string) => h.popup({ kind: INVITATION_MESSAGE_KIND, op: "present", opening }) as Promise<Extract<InvitationReply, { status: "present" }>>;
const control = (send: H["popup"], c: "site" | "feature" | "global") => send({ kind: INVITATION_MESSAGE_KIND, op: "control", control: c });
const commit = (h: H, reservation: unknown) => h.popup({ kind: INVITATION_MESSAGE_KIND, op: "commit", reservation }) as Promise<Extract<InvitationReply, { status: "commit" }>>;

/** Three direct controls, then a later popup opening that earns the card. */
async function earnMilestone(h: H) {
  expect((await present(h, "opening-1")).card).toBeNull();
  await control(h.popup, "site"); await control(h.popup, "feature"); await control(h.popup, "global");
}

describe("request reading", () => {
  const ok = { kind: INVITATION_MESSAGE_KIND, op: "present", opening: "o" };
  it("accepts only the three exact shapes", () => {
    expect(readInvitationRequest(ok)).not.toBeNull();
    expect(readInvitationRequest({ ...ok, extra: 1 })).toBeNull();
    expect(readInvitationRequest({ ...ok, op: "other" })).toBeNull();
    expect(readInvitationRequest({ ...ok, opening: "  " })).toBeNull();
    expect(readInvitationRequest({ kind: "x", op: "present", opening: "o" })).toBeNull();
    expect(readInvitationRequest({ kind: INVITATION_MESSAGE_KIND, op: "control", control: "pause" })).toBeNull();
    // A page cannot claim a source, an outcome, a signed-out state or readiness.
    expect(readInvitationRequest({ kind: INVITATION_MESSAGE_KIND, op: "control", control: "site", source: "direct" })).toBeNull();
    expect(readInvitationRequest({ kind: INVITATION_MESSAGE_KIND, op: "control", control: "site", signedIn: false })).toBeNull();
  });
  it("accepts only a sync reservation to commit", () => {
    const reservation = { kind: "sync", opening: "o", generation: 3 };
    expect(readInvitationRequest({ kind: INVITATION_MESSAGE_KIND, op: "commit", reservation })).not.toBeNull();
    expect(readInvitationRequest({ kind: INVITATION_MESSAGE_KIND, op: "commit", reservation: { ...reservation, kind: "rating" } })).toBeNull();
    expect(readInvitationRequest({ kind: INVITATION_MESSAGE_KIND, op: "commit", reservation: { ...reservation, generation: -1 } })).toBeNull();
    expect(readInvitationRequest({ kind: INVITATION_MESSAGE_KIND, op: "commit", reservation: { ...reservation, extra: 1 } })).toBeNull();
  });
});

describe("who may ask", () => {
  it("answers extension pages only; content scripts and other extensions are ignored", async () => {
    const h = harness();
    const msg = { kind: INVITATION_MESSAGE_KIND, op: "present", opening: "o" };
    expect(await h.page("https://www.youtube.com/watch")(msg)).toBeUndefined();
    expect(await h.page(`${ORIGIN}popup.html`, "other")(msg)).toBeUndefined();
    expect(await h.page("chrome-extension://evil/popup.html")(msg)).toBeUndefined();
    expect(h.area.values[INVITATION_LEDGER_KEY]).toBeUndefined();
    expect((await h.popup(msg))?.status).toBe("present");
  });
});

describe("the sync milestone", () => {
  it("three successful signed-out direct controls, then a later popup opening shows the card once", async () => {
    const h = harness();
    await earnMilestone(h);
    // The opening that earned it never shows it.
    expect((await present(h, "opening-1")).card).toBeNull();
    const second = await present(h, "opening-2");
    expect(second.card?.reservation).toMatchObject({ kind: "sync", opening: "opening-2" });
    expect(second.card?.installation).toBe(h.ledger()!.installation);
    expect((await commit(h, second.card!.reservation)).committed).toBe(true);
    expect(h.ledger()).toMatchObject({ sync: "consumed", shown: 1, reservation: null });
    // Consumed means gone: neither this opening nor any later one shows it again.
    expect((await present(h, "opening-2")).card).toBeNull();
    expect((await present(h, "opening-3")).card).toBeNull();
  });

  it("two controls are not enough, and controls after the third change nothing", async () => {
    const h = harness();
    await present(h, "opening-1");
    await control(h.popup, "site"); await control(h.options, "feature");
    expect(h.ledger()).toMatchObject({ milestones: 2, sync: "idle" });
    expect((await present(h, "opening-2")).card).toBeNull();
    await control(h.options, "global");
    expect(h.ledger()).toMatchObject({ milestones: 3, sync: "earned" });
    await control(h.options, "global");
    expect(h.ledger()!.milestones).toBe(3);
  });

  it("counts the global pause (owner ruling) and uses the owner parameters for every control kind", () => {
    expect(SYNC_INVITATION_PARAMETERS.countedControls).toEqual(["site", "feature", "global"]);
    expect(SYNC_INVITATION_PARAMETERS.spaceRatingFromInvitations).toBe(false);
  });

  it("does not count controls made while signed in or when sign-in state is unknown", async () => {
    for (const account of ["signed-in", "unknown"] as const) {
      const h = harness({ account });
      await present(h, "opening-1");
      for (const c of ["site", "feature", "global"] as const) await control(h.popup, c);
      expect(h.ledger()).toMatchObject({ milestones: 0, sync: "idle" });
    }
  });

  it("does not count controls before first-run is finished (setup-time changes)", async () => {
    const h = harness({ finished: false });
    await present(h, "opening-1");
    for (const c of ["site", "feature", "global"] as const) await control(h.popup, c);
    expect(h.ledger()).toMatchObject({ milestones: 0, sync: "idle" });
  });

  it("signed-in users see nothing, and signing in never consumes the earned card", async () => {
    const h = harness();
    await earnMilestone(h);
    h.facts.account = "signed-in";
    expect((await present(h, "opening-2")).card).toBeNull();
    expect(h.ledger()).toMatchObject({ sync: "due", shown: 0 });
    h.facts.account = "signed-out";
    expect((await present(h, "opening-3")).card).not.toBeNull();
  });

  it("shows no card in a build with no sign-in", async () => {
    const h = harness({ signInAvailable: false });
    await earnMilestone(h);
    expect((await present(h, "opening-2")).card).toBeNull();
  });

  it("shows no card during setup, and setup suppression does not consume it", async () => {
    const h = harness();
    await earnMilestone(h);
    h.facts.finished = false;
    expect((await present(h, "opening-2")).card).toBeNull();
    expect(h.ledger()).toMatchObject({ sync: "due", shown: 0, reservation: null });
    h.facts.finished = true;
    expect((await present(h, "opening-3")).card?.reservation.kind).toBe("sync");
  });

  it("an abandoned reservation is released by the next opening and the card can still show", async () => {
    const h = harness();
    await earnMilestone(h);
    const crashed = await present(h, "opening-2");
    expect(crashed.card).not.toBeNull();
    // Crash after reserving, before the commit: nothing was ever visible.
    expect(h.ledger()).toMatchObject({ sync: "due", shown: 0 });
    const next = await present(h, "opening-3");
    expect(next.card).not.toBeNull();
    // A stale host from the crashed opening cannot consume.
    expect((await commit(h, crashed.card!.reservation)).committed).toBe(false);
    expect((await commit(h, next.card!.reservation)).committed).toBe(true);
  });
});

describe("caps and spacing (168 hours, at most two per install)", () => {
  const seeded = (h: H, patch: Partial<InvitationLedger>) => {
    const base = createInvitationLedger("install-seed", null)!;
    h.area.values[INVITATION_LEDGER_KEY] = { ...base, lastOpening: "seed", highWaterMs: T0 - 1000 * HOUR, dayOrdinal: 1, ...patch };
  };
  it("waits the full 168 hours after another invitation, then shows", async () => {
    const h = harness();
    const shownAt = T0 - 167 * HOUR;
    seeded(h, { link: "consumed", shown: 1, lastInvitationAt: shownAt, sync: "due", highWaterMs: shownAt });
    expect((await present(h, "opening-a")).card).toBeNull();
    h.facts.now = shownAt + 168 * HOUR - 1;
    expect((await present(h, "opening-b")).card).toBeNull();
    h.facts.now = shownAt + 168 * HOUR;
    expect((await present(h, "opening-c")).card).not.toBeNull();
  });
  it("never shows a third invitation", async () => {
    const h = harness();
    seeded(h, { link: "consumed", shown: 2, lastInvitationAt: T0 - 1000 * HOUR, sync: "due" });
    expect((await present(h, "opening-a")).card).toBeNull();
  });
});

describe("one serialized queue across contexts", () => {
  it("popup and options sending at once never lose a count or double-consume", async () => {
    const h = harness();
    await present(h, "opening-1");
    // Six controls from two pages at once: the count saturates at 3 and the card is earned once.
    await Promise.all([
      control(h.popup, "site"), control(h.options, "feature"), control(h.popup, "global"),
      control(h.options, "site"), control(h.popup, "feature"), control(h.options, "global"),
    ]);
    expect(h.ledger()).toMatchObject({ milestones: 3, sync: "earned" });
    // Two popups open together on different openings: exactly one reservation can win.
    const winners = await Promise.all(["opening-2", "opening-3", "opening-4"].map(o => present(h, o)));
    expect(winners.filter(w => w.card !== null)).toHaveLength(1);
    const winner = winners.find(w => w.card)!.card!;
    // Parallel commits of the same reservation consume once.
    const commits = await Promise.all([commit(h, winner.reservation), commit(h, winner.reservation), commit(h, winner.reservation)]);
    expect(commits.filter(c => c.committed)).toHaveLength(1);
    expect(h.ledger()).toMatchObject({ sync: "consumed", shown: 1 });
  });

  it("a ledger transaction waits behind earlier work in the same queue", async () => {
    const h = harness();
    let release!: () => void;
    const held = h.serialize(() => new Promise<void>(r => { release = r; }));
    const pending = present(h, "opening-1");
    await new Promise(r => setTimeout(r, 20));
    expect(h.area.values[INVITATION_LEDGER_KEY]).toBeUndefined();
    release(); await held; await pending;
    expect(h.ledger()).not.toBeNull();
  });

  it("an unserialized store over the same slow area loses updates (the reason pages never open their own)", async () => {
    const area = slowArea();
    const direct = () => new InvitationLedgerStore(chromeInvitationLedgerPort(body => body(), area), SYNC_INVITATION_PARAMETERS);
    const a = direct(), b = direct();
    await a.ensure("install", null);
    await a.recordOpening({ opening: "o", ordinary: true, nowMs: T0, localDay: 1 });
    const input = { control: "site" as const, source: "direct" as const, outcome: "succeeded" as const, signedIn: false, ready: true };
    await Promise.all([a.recordDirectControl(input), b.recordDirectControl(input), a.recordDirectControl(input)]);
    expect(parseInvitationLedger(area.values[INVITATION_LEDGER_KEY])!.milestones).toBeLessThan(3);
  });
});

describe("readiness is the browser's own site access", () => {
  const manifest = { host_permissions: ["*://*.youtube.com/*", "*://*.instagram.com/*"] };
  it("asks for exactly the declared hosts and is false with none declared", async () => {
    const contains = vi.fn(async () => true);
    expect(await declaredHostsGranted({ contains } as never, manifest)).toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: manifest.host_permissions });
    expect(await declaredHostsGranted({ contains } as never, {})).toBe(false);
  });
});
