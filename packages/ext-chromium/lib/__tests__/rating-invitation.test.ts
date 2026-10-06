import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicSettingsWriter } from "@still/core/storage";
import {
  INVITATION_LEDGER_KEY, parseInvitationLedger, type InvitationLedger, type InvitationReservation,
} from "../../../core/src/invitations/index.js";
import type { RatingAllowance } from "../../../core/src/invitations/rating-allowance.js";
import {
  ACCOUNT_READ_LIMIT_MS, BROWSER_INVITATION_PARAMETERS, BROWSER_RATING_ALLOWANCE_MS, INVITATION_MESSAGE_KIND,
  chromeInvitationLedgerPort, createInvitationHost, readInvitationRequest, type InvitationReply,
} from "../invitation-background.js";
import { INVITATION_REPLY_TIMEOUT_MS, invitationPort, reportDirectControl, windowIsPrivate } from "../invitation-client.js";
import { presentInvitation, type PopupInvitationPort } from "../../../core/src/ui/v3/popup-invitation-flow.js";
import { browserRatingAllowance, firefoxPlatform, ratingPolicySurfaceFor } from "../rating-invitation.js";
import { BUILD, ENDPOINT, SUPABASE_URL, memoryArea, ok, ratingBody } from "./product-policy-fixtures.js";

// The browser rating card through the shared invitation handler (U13-P3 reconciled onto U13-P2):
// one opening record, 168 hours between any two invitations, the first-run anchor from the
// original-install record, and Firefox for Android asking for the firefox_android allowance.

const HOUR = 3_600_000, DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1, 12);
const EXTENSION = "extid", ORIGIN = "chrome-extension://extid/";
const ON: RatingAllowance = { allowed: true, reason: "on" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Account = "signed-out" | "signed-in" | "unknown";
function harness(overrides: Partial<{ account: Account; firstRunAt: number | null; rating: boolean }> = {}) {
  const facts = {
    account: "signed-in" as Account, firstRunAt: T0 as number | null, now: T0, allowance: ON, rating: true, ...overrides,
  };
  const values: Record<string, unknown> = {};
  const area = {
    get: async (key: string) => (key in values ? { [key]: structuredClone(values[key]) } : {}),
    set: async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)); },
  } as unknown as Pick<chrome.storage.LocalStorageArea, "get" | "set">;
  const writer = new AtomicSettingsWriter({ get: async () => null, set: vi.fn(), subscribe: () => () => {} });
  const freshCheck = vi.fn(async () => facts.allowance);
  let ids = 0;
  const host = createInvitationHost({
    port: chromeInvitationLedgerPort(writer.serializeLocalMutation.bind(writer) as <T>(b: () => Promise<T>) => Promise<T>, area),
    setupFinished: async () => true,
    account: async () => facts.account,
    signInAvailable: true,
    now: () => facts.now,
    newInstallationId: () => `install-${++ids}`,
    firstRunAt: async () => facts.firstRunAt,
    rating: facts.rating ? { surface: "chrome", freshCheck } : undefined,
  });
  const listener = host.listener(EXTENSION, ORIGIN);
  const send = (message: unknown) => new Promise<InvitationReply | undefined>(resolve => {
    if (!listener(message, { id: EXTENSION, url: `${ORIGIN}popup.html` } as chrome.runtime.MessageSender, resolve as (v: unknown) => void))
      resolve(undefined);
  });
  const present = async (opening: string, at?: number, extra: object = {}) => {
    if (at !== undefined) facts.now = at;
    return ((await send({ kind: INVITATION_MESSAGE_KIND, op: "present", opening, ...extra })) as Extract<InvitationReply, { status: "present" }>).card;
  };
  const commit = async (reservation: InvitationReservation) =>
    ((await send({ kind: INVITATION_MESSAGE_KIND, op: "commit", reservation })) as Extract<InvitationReply, { status: "commit" }>)?.committed;
  const ledger = (): InvitationLedger => parseInvitationLedger(values[INVITATION_LEDGER_KEY])!;
  const seed = (patch: Partial<InvitationLedger>) => { values[INVITATION_LEDGER_KEY] = { ...ledger(), ...patch }; };
  return { facts, values, freshCheck, present, commit, ledger, seed, send };
}
type H = ReturnType<typeof harness>;

/** Three days of use from first run, then an opening eight days in: locally due for rating. */
async function dueForRating(h: H) {
  for (let i = 0; i < 3; i++) expect(await h.present(`day-${i + 1}`, T0 + i * DAY)).toBeNull();
  expect(h.freshCheck).not.toHaveBeenCalled();
  h.facts.now = T0 + 8 * DAY;
}

describe("the rating card through the shared invitation handler", () => {
  it("a locally due opening asks one fresh allowance, reserves, and the popup's commit spends it", async () => {
    const h = harness();
    await dueForRating(h);
    const card = await h.present("opening-r");
    expect(card?.reservation).toMatchObject({ kind: "rating", opening: "opening-r" });
    expect(h.freshCheck).toHaveBeenCalledOnce();
    // Reserved, not spent, until the popup commits immediately before rendering.
    expect(h.ledger()).toMatchObject({ rating: "due", reservation: { kind: "rating" } });
    expect(await h.commit(card!.reservation)).toBe(true);
    expect(h.ledger()).toMatchObject({ rating: "consumed", reservation: null, lastCardOpening: "opening-r" });
    expect(await h.present("opening-later", T0 + 40 * DAY)).toBeNull();
    expect(h.freshCheck).toHaveBeenCalledOnce();
  });

  it("Off, or anything but a fresh On, reserves nothing", async () => {
    for (const allowance of [{ allowed: false, reason: "off" }, { allowed: false, reason: "stale" }, { allowed: true, reason: "late" }]) {
      const h = harness();
      await dueForRating(h);
      h.facts.allowance = allowance;
      expect(await h.present("opening-r")).toBeNull();
      expect(h.ledger()).toMatchObject({ rating: "due", reservation: null });
    }
  });

  it("a build without the rating card never asks and never shows it", async () => {
    const h = harness({ rating: false });
    await dueForRating(h);
    expect(await h.present("opening-r")).toBeNull();
  });

  it("a due sync card outranks rating; an unknown account shows neither", async () => {
    const h = harness({ account: "unknown" });
    await dueForRating(h);
    h.seed({ sync: "due" });
    expect(await h.present("opening-r")).toBeNull();
    expect(h.freshCheck).not.toHaveBeenCalled();
    h.facts.account = "signed-out";
    expect((await h.present("opening-s"))?.reservation.kind).toBe("sync");
    h.facts.account = "signed-in";
    expect((await h.present("opening-t", T0 + 9 * DAY))?.reservation.kind).toBe("rating");
  });

  it("only a sync or rating reservation can be committed from a page", async () => {
    const h = harness();
    await dueForRating(h);
    const card = await h.present("opening-r");
    expect(await h.commit({ ...card!.reservation, kind: "link" })).toBeUndefined();
    expect(await h.commit(card!.reservation)).toBe(true);
  });
});

describe("(a) one opening record shared by both cards", () => {
  it("each popup opening is recorded once, and the rating card is reserved for exactly that opening", async () => {
    const h = harness();
    await dueForRating(h);
    const generation = h.ledger().generation;
    const card = await h.present("opening-r");
    expect(card?.reservation.opening).toBe("opening-r");
    expect(h.ledger().lastOpening).toBe("opening-r");
    // One record (the opening) and one reservation: no second opening was written for rating.
    expect(h.ledger().generation).toBe(generation + 1);
    expect(h.ledger().distinctDays).toBe(3);
  });

  it("a sync card shown on an opening uses it up: rating never shows on the same opening", async () => {
    const h = harness({ account: "signed-out" });
    await dueForRating(h);
    h.seed({ sync: "due" });
    const sync = await h.present("opening-x");
    expect(sync?.reservation.kind).toBe("sync");
    expect(await h.commit(sync!.reservation)).toBe(true);
    h.facts.account = "signed-in";
    expect(await h.present("opening-x")).toBeNull();
    expect(h.freshCheck).not.toHaveBeenCalled();
  });
});

describe("(b) at least 168 hours between any two invitations", () => {
  it("rating waits 168 hours after a sync card", async () => {
    const h = harness();
    await dueForRating(h);
    const shownAt = T0 + 8 * DAY;
    h.seed({ sync: "consumed", shown: 1, lastInvitationAt: shownAt, highWaterMs: shownAt });
    expect(await h.present("opening-1", shownAt + 168 * HOUR - 1)).toBeNull();
    expect(h.freshCheck).not.toHaveBeenCalled();
    expect((await h.present("opening-2", shownAt + 168 * HOUR))?.reservation.kind).toBe("rating");
  });

  it("a sync card waits 168 hours after the rating card", async () => {
    const h = harness();
    await dueForRating(h);
    const rated = await h.present("opening-r");
    expect(await h.commit(rated!.reservation)).toBe(true);
    const ratedAt = h.ledger().lastRatingAt!;
    h.facts.account = "signed-out";
    h.seed({ sync: "due" });
    expect(await h.present("opening-1", ratedAt + 168 * HOUR - 1)).toBeNull();
    expect((await h.present("opening-2", ratedAt + 168 * HOUR))?.reservation.kind).toBe("sync");
  });

  it("the shared parameters space rating from invitations and count the global pause", () => {
    expect(BROWSER_INVITATION_PARAMETERS).toEqual({ spaceRatingFromInvitations: true, countedControls: ["site", "feature", "global"] });
  });
});

describe("(c) the first-run anchor comes from the original-install record", () => {
  it("a new ledger starts at the first-run time, or at its first opening if that is later", async () => {
    // A first-run record dated after the first opening (a clock that ran ahead) is used as it is.
    const ahead = harness({ firstRunAt: T0 + HOUR });
    await ahead.present("day-1", T0);
    expect(ahead.ledger().anchorMs).toBe(T0 + HOUR);
    // A past-dated record (a clock behind at first run, an old install) never shortens the wait.
    const behind = harness({ firstRunAt: T0 - 30 * DAY });
    await behind.present("day-1", T0);
    expect(behind.ledger().anchorMs).toBe(T0);
  });

  it("a past-dated first-run record cannot bring the rating card forward", async () => {
    const h = harness({ firstRunAt: T0 - 365 * DAY });
    for (let i = 0; i < 3; i++) await h.present(`day-${i + 1}`, T0 + i * DAY);
    expect(await h.present("opening-early", T0 + 7 * DAY - 1)).toBeNull();
    expect(h.freshCheck).not.toHaveBeenCalled();
    expect((await h.present("opening-due", T0 + 7 * DAY))?.reservation.kind).toBe("rating");
  });

  it("a ledger created before the record was readable adopts it once, clamped, and never moves it", async () => {
    const h = harness({ firstRunAt: null });
    await h.present("day-1", T0);
    expect(h.ledger().anchorMs).toBeNull();
    h.facts.firstRunAt = T0 - DAY;
    await h.present("day-2", T0 + DAY);
    // Adopted no earlier than the opening that learned it.
    expect(h.ledger().anchorMs).toBe(T0 + DAY);
    h.facts.firstRunAt = T0 + 5 * DAY;
    await h.present("day-3", T0 + 2 * DAY);
    expect(h.ledger().anchorMs).toBe(T0 + DAY);
  });

  it("a past-dated first-run record adopted late (also from a control) cannot bring the card forward", async () => {
    const h = harness({ firstRunAt: null });
    await h.present("day-1", T0);
    h.facts.firstRunAt = T0 - 365 * DAY;
    h.facts.now = T0 + DAY;
    await h.send({ kind: INVITATION_MESSAGE_KIND, op: "control", control: "site" });
    expect(h.ledger().anchorMs).toBe(T0 + DAY);
    await h.present("day-2", T0 + DAY);
    await h.present("day-3", T0 + 2 * DAY);
    expect(await h.present("opening-early", T0 + 8 * DAY - 1)).toBeNull();
    expect(h.freshCheck).not.toHaveBeenCalled();
    expect((await h.present("opening-due", T0 + 8 * DAY))?.reservation.kind).toBe("rating");
  });

  it("with no known first-run time, rating never becomes due", async () => {
    const h = harness({ firstRunAt: null });
    await dueForRating(h);
    expect(await h.present("opening-r", T0 + 60 * DAY)).toBeNull();
    expect(h.freshCheck).not.toHaveBeenCalled();
  });

  it("an unreadable or nonsensical first-run time is unknown", async () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const h = harness({ firstRunAt: bad });
      await h.present("day-1", T0);
      expect(h.ledger().anchorMs).toBeNull();
    }
  });
});

describe("(d) Firefox for Android asks for the firefox_android allowance", () => {
  const platform = (os: string) => ({ getPlatformInfo: async () => ({ os }) });

  it("maps the browser's own platform answer, and refuses when there is none", async () => {
    expect(await ratingPolicySurfaceFor(false, undefined)).toBe("chrome_desktop");
    expect(await ratingPolicySurfaceFor(true, platform("android"))).toBe("firefox_android");
    for (const os of ["mac", "win", "linux", "openbsd"]) expect(await ratingPolicySurfaceFor(true, platform(os))).toBe("firefox_desktop");
    expect(await ratingPolicySurfaceFor(true, undefined)).toBeNull();
    expect(await ratingPolicySurfaceFor(true, {})).toBeNull();
    expect(await ratingPolicySurfaceFor(true, { getPlatformInfo: async () => { throw new Error("no"); } })).toBeNull();
    expect(await ratingPolicySurfaceFor(true, platform(""))).toBeNull();
    expect(await firefoxPlatform({ getPlatformInfo: () => new Promise(() => {}) }, 10)).toBeNull();
  });

  it("asks the policy for the resolved surface, and asks nothing when the platform is unknown", async () => {
    const asked: string[] = [];
    const policyFor = (surface: string) => ({ freshCheck: vi.fn(async () => { asked.push(surface); return { allowed: true, reason: "on" as const, revision: 1 }; }) });
    const android = browserRatingAllowance({ isFirefox: true, supabaseUrl: SUPABASE_URL, production: true, build: BUILD, runtime: platform("android"), policyFor });
    expect(await android()).toEqual({ allowed: true, reason: "on" });
    const desktop = browserRatingAllowance({ isFirefox: true, supabaseUrl: SUPABASE_URL, production: true, build: BUILD, runtime: platform("win"), policyFor });
    await desktop();
    const chromeBuild = browserRatingAllowance({ isFirefox: false, supabaseUrl: SUPABASE_URL, production: true, build: BUILD, runtime: platform("android"), policyFor });
    await chromeBuild();
    expect(asked).toEqual(["firefox_android", "firefox_desktop", "chrome_desktop"]);
    const unknown = browserRatingAllowance({ isFirefox: true, supabaseUrl: SUPABASE_URL, production: true, build: BUILD, runtime: {}, policyFor });
    expect(await unknown()).toEqual({ allowed: false, reason: "platform" });
    expect(asked).toHaveLength(3);
  });

  it("with the real client, a desktop-only allowance never authorizes Firefox for Android", async () => {
    const storage = memoryArea();
    vi.stubGlobal("chrome", { storage: { local: storage.area } });
    const desktopOnly = ratingBody();
    vi.stubGlobal("fetch", vi.fn(async () => ok(desktopOnly)));
    const android = browserRatingAllowance({ isFirefox: true, supabaseUrl: SUPABASE_URL, production: true, build: BUILD, runtime: platform("android") });
    expect(await android()).toEqual({ allowed: false, reason: "build" });
    const androidBody = desktopOnly.replace('{"surface":"firefox_desktop"', '{"surface":"firefox_android"');
    vi.stubGlobal("fetch", vi.fn(async () => ok(androidBody)));
    expect(await browserRatingAllowance({ isFirefox: true, supabaseUrl: SUPABASE_URL, production: true, build: BUILD, runtime: platform("android") })())
      .toEqual({ allowed: true, reason: "on" });
  });
});

describe("the real client: only a fresh On counts", () => {
  it("a cached On alone never authorizes: the ordinary cache says On, the fresh check fails", async () => {
    const storage = memoryArea({
      "still:productPolicy:rating:highestSeenRevision": 5,
      "still:productPolicy:rating:ordinary": { schema: 1, revision: 5, projection: { on: true }, lastSuccess: Date.now(), highWater: Date.now() },
    });
    vi.stubGlobal("chrome", { storage: { local: storage.area } });
    const network = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", network);
    const check = browserRatingAllowance({ isFirefox: false, supabaseUrl: SUPABASE_URL, production: true, build: BUILD, runtime: undefined });
    expect(await check()).toEqual({ allowed: false, reason: "missing" });
    expect(network).toHaveBeenCalledOnce();
  });

  it("makes no request without a project URL, and sends nothing but the one policy read otherwise", async () => {
    const storage = memoryArea();
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { storage: { local: storage.area }, runtime: { sendMessage } });
    const network = vi.fn(async () => ok(ratingBody()));
    vi.stubGlobal("fetch", network);
    expect(await browserRatingAllowance({ isFirefox: false, supabaseUrl: undefined, production: true, build: BUILD, runtime: undefined })())
      .toEqual({ allowed: false, reason: "missing" });
    expect(network).not.toHaveBeenCalled();
    expect(await browserRatingAllowance({ isFirefox: false, supabaseUrl: SUPABASE_URL, production: true, build: BUILD, runtime: undefined })())
      .toEqual({ allowed: true, reason: "on" });
    expect(network.mock.calls.map(call => String((call as unknown[])[0]))).toEqual([ENDPOINT]);
    // No analytics message, ever.
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("a private window counts for nothing (both cards)", () => {
  it("a private opening leaves the ledger byte-identical and asks no allowance, for the rating card", async () => {
    const h = harness();
    await dueForRating(h);
    const before = JSON.stringify(h.values);
    expect(await h.present("opening-private", undefined, { ordinary: false })).toBeNull();
    expect(JSON.stringify(h.values)).toBe(before);
    expect(h.freshCheck).not.toHaveBeenCalled();
    // The next ordinary opening can still show it.
    expect((await h.present("opening-r"))?.reservation.kind).toBe("rating");
  });

  it("a private opening leaves the ledger byte-identical for the sync card, and creates no ledger at all", async () => {
    const h = harness({ account: "signed-out" });
    await dueForRating(h);
    h.seed({ sync: "due" });
    const before = JSON.stringify(h.values);
    expect(await h.present("opening-private", T0 + 9 * DAY, { ordinary: false })).toBeNull();
    expect(JSON.stringify(h.values)).toBe(before);
    expect((await h.present("opening-s"))?.reservation.kind).toBe("sync");
    const fresh = harness();
    expect(await fresh.present("opening-private", T0, { ordinary: false })).toBeNull();
    expect(fresh.values).toEqual({});
  });

  it("the request accepts `ordinary: false` only, alone or with a hold", () => {
    const base = { kind: INVITATION_MESSAGE_KIND, op: "present", opening: "o" };
    expect(readInvitationRequest({ ...base, ordinary: false })).toEqual({ ...base, ordinary: false });
    expect(readInvitationRequest({ ...base, hold: "setup", ordinary: false })).toEqual({ ...base, hold: "setup", ordinary: false });
    for (const ordinary of [true, "false", 0, null, undefined]) expect(readInvitationRequest({ ...base, ordinary })).toBeNull();
    expect(readInvitationRequest({ ...base, ordinary: false, extra: 1 })).toBeNull();
  });

  describe("the popup resolves privacy before it asks", () => {
    const windows = (incognito: unknown) => ({ getCurrent: async () => ({ incognito }) });
    it("is private when the window or the extension context says so", async () => {
      expect(await windowIsPrivate({ windows: windows(true), extension: { inIncognitoContext: true } })).toBe(true);
      // Chrome spanning mode: the popup's context says false over a private window.
      expect(await windowIsPrivate({ windows: windows(true), extension: { inIncognitoContext: false } })).toBe(true);
      expect(await windowIsPrivate({ windows: windows(false), extension: { inIncognitoContext: true } })).toBe(true);
      expect(await windowIsPrivate({ windows: windows(false), extension: { inIncognitoContext: false } })).toBe(false);
    });
    it("an error, a late or unknown answer counts as private", async () => {
      expect(await windowIsPrivate({ windows: { getCurrent: async () => { throw new Error("no"); } }, extension: { inIncognitoContext: false } })).toBe(true);
      expect(await windowIsPrivate({ windows: { getCurrent: () => new Promise(() => {}) }, extension: { inIncognitoContext: false } }, 10)).toBe(true);
      expect(await windowIsPrivate({ windows: windows(undefined), extension: { inIncognitoContext: false } })).toBe(true);
      expect(await windowIsPrivate({ windows: windows(false), extension: {} })).toBe(true);
      expect(await windowIsPrivate({ windows: windows(false) })).toBe(true);
      expect(await windowIsPrivate(undefined)).toBe(true);
      expect(await windowIsPrivate({})).toBe(true);
    });
    it("with no windows API (Firefox for Android) the extension context's own answer decides", async () => {
      expect(await windowIsPrivate({ extension: { inIncognitoContext: false } })).toBe(false);
      expect(await windowIsPrivate({ extension: { inIncognitoContext: true } })).toBe(true);
    });
  });
});

describe("time budget: the rating allowance fits inside the popup's wait", () => {
  it("account read plus allowance leaves room inside the reply timeout", () => {
    expect(ACCOUNT_READ_LIMIT_MS + BROWSER_RATING_ALLOWANCE_MS).toBeLessThan(INVITATION_REPLY_TIMEOUT_MS);
    expect(BROWSER_RATING_ALLOWANCE_MS).toBe(1_500);
  });

  it.each([[BROWSER_RATING_ALLOWANCE_MS - 1, "rating"], [BROWSER_RATING_ALLOWANCE_MS + 1, null]] as const)(
    "an allowance answering after %i ms gives %s",
    async (delay, expected) => {
      const h = harness();
      await dueForRating(h);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      h.freshCheck.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(ON), delay)));
      const card = h.present("opening-r");
      await vi.advanceTimersByTimeAsync(BROWSER_RATING_ALLOWANCE_MS + 10);
      expect((await card)?.reservation.kind ?? null).toBe(expected);
      if (expected === null) expect(h.ledger()).toMatchObject({ rating: "due", reservation: null });
    },
  );
});

describe("a private window's direct controls count for nothing", () => {
  const control = (h: H, c: "site" | "feature" | "global", ordinary?: false) =>
    h.send({ kind: INVITATION_MESSAGE_KIND, op: "control", control: c, ...(ordinary === false ? { ordinary } : {}) });

  it("three private controls create no ledger, and leave an existing one byte-identical", async () => {
    const absent = harness({ account: "signed-out" });
    for (const c of ["site", "feature", "global"] as const) expect(await control(absent, c, false)).toEqual({ status: "control" });
    expect(absent.values).toEqual({});
    const h = harness({ account: "signed-out" });
    await h.present("opening-1", T0);
    const before = JSON.stringify(h.values);
    for (const c of ["site", "feature", "global"] as const) await control(h, c, false);
    expect(JSON.stringify(h.values)).toBe(before);
    expect(h.ledger()).toMatchObject({ milestones: 0, sync: "idle" });
  });

  it("three ordinary controls still earn the sync card", async () => {
    const h = harness({ account: "signed-out" });
    await h.present("opening-1", T0);
    for (const c of ["site", "feature", "global"] as const) await control(h, c);
    expect(h.ledger()).toMatchObject({ milestones: 3, sync: "earned" });
    expect((await h.present("opening-2", T0 + HOUR))?.reservation.kind).toBe("sync");
  });

  it("the request accepts `ordinary: false` on a control, and nothing else", () => {
    const base = { kind: INVITATION_MESSAGE_KIND, op: "control", control: "site" };
    expect(readInvitationRequest({ ...base, ordinary: false })).toEqual({ ...base, ordinary: false });
    for (const ordinary of [true, "false", null]) expect(readInvitationRequest({ ...base, ordinary })).toBeNull();
    expect(readInvitationRequest({ ...base, ordinary: false, source: "direct" })).toBeNull();
  });
});

describe("the page port derives privacy from the browser itself", () => {
  const stub = (incognito: boolean, context: boolean) => {
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal("chrome", {
      windows: { getCurrent: async () => ({ incognito }) },
      extension: { inIncognitoContext: context },
      runtime: { sendMessage: async (message: Record<string, unknown>) => { sent.push(message); return { status: "present", card: null }; } },
    });
    return sent;
  };

  it.each([[true, false], [false, true], [true, true]])("present sends ordinary:false (window %s, context %s)", async (incognito, context) => {
    const sent = stub(incognito, context);
    await invitationPort.present("opening-1");
    expect(sent).toEqual([{ kind: INVITATION_MESSAGE_KIND, op: "present", opening: "opening-1", ordinary: false }]);
  });

  it("an ordinary window sends no ordinary key, for present and for controls", async () => {
    const sent = stub(false, false);
    await invitationPort.present("opening-1", "setup");
    reportDirectControl("site");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([
      { kind: INVITATION_MESSAGE_KIND, op: "present", opening: "opening-1", hold: "setup" },
      { kind: INVITATION_MESSAGE_KIND, op: "control", control: "site" },
    ]);
  });

  it("a control from a private window is sent with ordinary:false", async () => {
    const sent = stub(true, false);
    reportDirectControl("feature");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ kind: INVITATION_MESSAGE_KIND, op: "control", control: "feature", ordinary: false });
  });
});

describe("a reservation abandoned because the popup was not ready", () => {
  it("is never committed, and the next ordinary opening reclaims it and can show the card", async () => {
    const h = harness();
    await dueForRating(h);
    const port: PopupInvitationPort = {
      present: async opening => (await h.present(opening)) ?? null,
      commit: async reservation => (await h.commit(reservation)) === true,
    };
    const shown: string[] = [];
    expect(await presentInvitation(port, "opening-a", r => shown.push(r.reservation.opening), undefined, () => false)).toBe(false);
    expect(h.ledger()).toMatchObject({ rating: "due", reservation: { kind: "rating", opening: "opening-a" } });
    expect(await presentInvitation(port, "opening-b", r => shown.push(r.reservation.opening), undefined, () => true)).toBe(true);
    expect(shown).toEqual(["opening-b"]);
    expect(h.ledger()).toMatchObject({ rating: "consumed", reservation: null, lastCardOpening: "opening-b" });
  });
});
