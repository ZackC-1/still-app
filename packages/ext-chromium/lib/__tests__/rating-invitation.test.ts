import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicSettingsWriter } from "@still/core/storage";
import {
  INVITATION_LEDGER_KEY, parseInvitationLedger, type InvitationLedger, type InvitationReservation,
} from "../../../core/src/invitations/index.js";
import type { RatingAllowance } from "../../../core/src/invitations/rating-allowance.js";
import {
  BROWSER_INVITATION_PARAMETERS, INVITATION_MESSAGE_KIND, chromeInvitationLedgerPort, createInvitationHost,
  type InvitationReply,
} from "../invitation-background.js";
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
  const present = async (opening: string, at?: number) => {
    if (at !== undefined) facts.now = at;
    return ((await send({ kind: INVITATION_MESSAGE_KIND, op: "present", opening })) as Extract<InvitationReply, { status: "present" }>).card;
  };
  const commit = async (reservation: InvitationReservation) =>
    ((await send({ kind: INVITATION_MESSAGE_KIND, op: "commit", reservation })) as Extract<InvitationReply, { status: "commit" }>)?.committed;
  const ledger = (): InvitationLedger => parseInvitationLedger(values[INVITATION_LEDGER_KEY])!;
  const seed = (patch: Partial<InvitationLedger>) => { values[INVITATION_LEDGER_KEY] = { ...ledger(), ...patch }; };
  return { facts, values, freshCheck, present, commit, ledger, seed };
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
  it("a new ledger starts at the first-run time, and the seven days count from it", async () => {
    const firstRun = T0 - 30 * DAY;
    const h = harness({ firstRunAt: firstRun });
    await h.present("day-1", T0);
    expect(h.ledger().anchorMs).toBe(firstRun);
  });

  it("a ledger created before the record was readable adopts it once, and never moves it", async () => {
    const h = harness({ firstRunAt: null });
    await h.present("day-1", T0);
    expect(h.ledger().anchorMs).toBeNull();
    h.facts.firstRunAt = T0 - DAY;
    await h.present("day-2", T0 + DAY);
    expect(h.ledger().anchorMs).toBe(T0 - DAY);
    h.facts.firstRunAt = T0 + 5 * DAY;
    await h.present("day-3", T0 + 2 * DAY);
    expect(h.ledger().anchorMs).toBe(T0 - DAY);
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
