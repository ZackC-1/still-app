import { afterEach, describe, expect, it, vi } from "vitest";
import { CHROME_WEB_STORE_REVIEW_URL, FIREFOX_ADDONS_REVIEW_URL } from "../../ui/config.js";
import { parseInvitationLedger, type InvitationLedger, type InvitationOwnerParameters } from "../ledger.js";
import { InMemoryInvitationLedgerPort, InvitationLedgerStore } from "../storage.js";
import {
  RATING_ALLOWANCE_TIMEOUT_MS, admitRatingCard, newLedgerAnchor, ratingCardSurface, recordRatingOpening,
  type RatingAdmissionDeps, type RatingAdmissionRequest, type RatingAllowance,
} from "../rating-allowance.js";
import { ratingReviewUrl } from "../rating-review.js";

const T0 = 1_790_000_000_000, DAY = 86_400_000, ZONE = "UTC";
const ON: RatingAllowance = { allowed: true, reason: "on" };
/** The browser's shared invitation parameters (BROWSER_INVITATION_PARAMETERS in ext-chromium). */
const PARAMETERS: InvitationOwnerParameters = { spaceRatingFromInvitations: true, countedControls: ["site", "feature", "global"] };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A ledger that is locally due for rating at opening `o4`, time T0 + 8 days. */
async function eligible() {
  const port = new InMemoryInvitationLedgerPort();
  const store = new InvitationLedgerStore(port, PARAMETERS);
  const open = (opening: string, nowMs: number) =>
    recordRatingOpening(store, { installation: "install-a", anchorMs: T0, opening, ordinary: true, nowMs, timeZone: ZONE });
  for (let i = 0; i < 3; i++) expect(await open(`o${i + 1}`, T0 + i * DAY)).toBe("ready");
  expect(await open("o4", T0 + 8 * DAY)).toBe("ready");
  return { port, store, open, now: T0 + 8 * DAY };
}
const ledger = (port: InMemoryInvitationLedgerPort): InvitationLedger => parseInvitationLedger(port.value)!;
const request = (extra: Partial<RatingAdmissionRequest> = {}): RatingAdmissionRequest =>
  ({ opening: "o4", surface: "chrome", syncApplicable: false, linkApplicable: false, suppressed: null, ...extra });
function deps(store: InvitationLedgerStore, now: number, extra: Partial<RatingAdmissionDeps> = {}) {
  const freshCheck = vi.fn(async (): Promise<RatingAllowance> => ON);
  return { freshCheck, deps: { store, now: () => now, hostSurface: "chrome" as const, freshCheck, ...extra } };
}

describe("packaged surfaces and review links", () => {
  it("only Chrome and Firefox have a browser card; Safari and Apple hosts never do", () => {
    expect(ratingCardSurface("chrome")).toBe("chrome");
    expect(ratingCardSurface("firefox")).toBe("firefox");
    for (const other of ["safari", "Safari", "apple_mobile_host", "apple_macos_host", "firefox-android", "edge", "", null, undefined, 1])
      expect(ratingCardSurface(other)).toBeNull();
  });
  it("opens the packaged default store review pages with no tracking parameters", () => {
    expect(ratingReviewUrl("chrome")).toBe(CHROME_WEB_STORE_REVIEW_URL);
    expect(ratingReviewUrl("firefox")).toBe(FIREFOX_ADDONS_REVIEW_URL);
    expect(CHROME_WEB_STORE_REVIEW_URL).toBe(
      "https://chromewebstore.google.com/detail/still-remove-shorts-reels/midpefhbieafmeboompbboemeahjjnkf/reviews");
    expect(FIREFOX_ADDONS_REVIEW_URL).toBe("https://addons.mozilla.org/firefox/addon/still-free-yourself/reviews/");
    for (const url of [CHROME_WEB_STORE_REVIEW_URL, FIREFOX_ADDONS_REVIEW_URL]) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.search).toBe("");
      expect(parsed.hash).toBe("");
      expect(url).not.toMatch(/utm_|ref=|campaign/i);
      // No locale segment: the store opens in the reader's own language.
      expect(parsed.pathname).not.toMatch(/\/[a-z]{2}(-[A-Z]{2})?\//);
    }
  });
});

describe("admission: local eligibility, one fresh allowance, then reserve and commit", () => {
  it("a fresh On for the captured opening commits the one attempt before the caller can render", async () => {
    const { port, store, now } = await eligible();
    const { deps: d, freshCheck } = deps(store, now);
    const result = await admitRatingCard(d, request());
    expect(result).toEqual({ admitted: true, surface: "chrome", opening: "o4", receipt: expect.stringMatching(/^rating-\d+$/) });
    expect(freshCheck).toHaveBeenCalledOnce();
    // Durable before the result exists: consumed, no reservation left, at most one card ever.
    expect(ledger(port)).toMatchObject({ rating: "consumed", reservation: null, lastCardOpening: "o4", lastRatingAt: now });
    expect(await admitRatingCard(d, request())).toEqual({ admitted: false, reason: "local" });
  });

  it("once per install: later openings never show it again and never ask the policy again", async () => {
    const { store, open, now } = await eligible();
    const { deps: d, freshCheck } = deps(store, now);
    expect((await admitRatingCard(d, request())).admitted).toBe(true);
    expect(await open("o5", now + 30 * DAY)).toBe("ready");
    const later = deps(store, now + 30 * DAY);
    expect(await admitRatingCard(later.deps, request({ opening: "o5" }))).toEqual({ admitted: false, reason: "local" });
    expect(later.freshCheck).not.toHaveBeenCalled();
    expect(freshCheck).toHaveBeenCalledOnce();
  });

  it("asks nothing when the ledger would not offer a rating card (too new, suppressed, other opening, spaced)", async () => {
    const { port, store, now } = await eligible();
    const cases: [number, Partial<RatingAdmissionRequest>][] = [
      [T0 + 7 * DAY - 1, {}],
      [now, { suppressed: "setup" }],
      [now, { suppressed: "error" }],
      [now, { opening: "o3" }],
    ];
    for (const [at, extra] of cases) {
      const { deps: d, freshCheck } = deps(store, at);
      expect(await admitRatingCard(d, request(extra))).toEqual({ admitted: false, reason: "local" });
      expect(freshCheck).not.toHaveBeenCalled();
    }
    // A sync invitation shown less than 168 h ago also holds rating (the spacing ruling).
    port.value = { ...ledger(port), lastInvitationAt: now - 604_800_000 + 1 };
    const spaced = deps(store, now);
    expect(await admitRatingCard(spaced.deps, request())).toEqual({ admitted: false, reason: "local" });
    port.value = { ...ledger(port), lastInvitationAt: now - 604_800_000 };
    expect((await admitRatingCard(deps(store, now).deps, request())).admitted).toBe(true);
  });

  it("a due sync card takes precedence over rating", async () => {
    const { port, store, now } = await eligible();
    port.value = { ...ledger(port), sync: "due" };
    const { deps: d, freshCheck } = deps(store, now);
    expect(await admitRatingCard(d, request({ syncApplicable: true }))).toEqual({ admitted: false, reason: "local" });
    expect(freshCheck).not.toHaveBeenCalled();
  });
});

describe("the allowance: only a fresh On for this opening counts", () => {
  const unchanged = (port: InMemoryInvitationLedgerPort) =>
    expect(ledger(port)).toMatchObject({ rating: "due", reservation: null, lastCardOpening: null });

  it("Off, missing, stale, wrong surface or build, and an On without the on reason all show nothing", async () => {
    const { port, store, now } = await eligible();
    const verdicts: RatingAllowance[] = [
      { allowed: false, reason: "off" }, { allowed: false, reason: "missing" }, { allowed: false, reason: "stale" },
      { allowed: false, reason: "build" }, { allowed: false, reason: "late" }, { allowed: false, reason: "invalid" },
      { allowed: false, reason: "context" }, { allowed: true, reason: "stale" }, { allowed: "true" as unknown as boolean, reason: "on" },
    ];
    for (const verdict of verdicts) {
      const { deps: d } = deps(store, now, { freshCheck: async () => verdict });
      expect(await admitRatingCard(d, request())).toEqual({ admitted: false, reason: "policy" });
      unchanged(port);
    }
  });

  it("a check that throws is Off", async () => {
    const { port, store, now } = await eligible();
    const { deps: d } = deps(store, now, { freshCheck: () => { throw new Error("offline"); } });
    expect(await admitRatingCard(d, request())).toEqual({ admitted: false, reason: "policy" });
    unchanged(port);
  });

  it("a check that has not answered in five seconds is Off, and its late On is never read", async () => {
    const { port, store, now } = await eligible();
    vi.useFakeTimers();
    let answer!: (value: RatingAllowance) => void;
    const { deps: d } = deps(store, now, { freshCheck: () => new Promise(resolve => { answer = resolve; }) });
    const pending = admitRatingCard(d, request());
    await vi.advanceTimersByTimeAsync(RATING_ALLOWANCE_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ admitted: false, reason: "policy" });
    answer(ON);
    await vi.advanceTimersByTimeAsync(10);
    unchanged(port);
  });

  it("an On captured for one opening never authorizes a newer opening", async () => {
    const { port, store, open, now } = await eligible();
    let answer!: (value: RatingAllowance) => void;
    const { deps: d } = deps(store, now, { freshCheck: () => new Promise(resolve => { answer = resolve; }) });
    const pending = admitRatingCard(d, request());
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    expect(await open("o5", now + 1)).toBe("ready");
    answer(ON);
    expect(await pending).toEqual({ admitted: false, reason: "reserve" });
    expect(ledger(port)).toMatchObject({ rating: "due", reservation: null, lastCardOpening: null });
  });
});

describe("surfaces: Safari never shows a card", () => {
  it("refuses Safari, a surface other than the host's own, and a host with no browser card, before any check", async () => {
    const { port, store, now } = await eligible();
    const cases: [RatingAdmissionDeps["hostSurface"], unknown][] = [
      ["chrome", "safari"], ["chrome", "firefox"], ["firefox", "chrome"], [null, "chrome"], [null, "safari"],
      ["chrome", "apple_mobile_host"], ["chrome", undefined],
    ];
    for (const [hostSurface, surface] of cases) {
      const { deps: d, freshCheck } = deps(store, now, { hostSurface });
      expect(await admitRatingCard(d, request({ surface }))).toEqual({ admitted: false, reason: "surface" });
      expect(freshCheck).not.toHaveBeenCalled();
    }
    expect(ledger(port).rating).toBe("due");
    const firefox = deps(store, now, { hostSurface: "firefox" });
    expect(await admitRatingCard(firefox.deps, request({ surface: "firefox" }))).toMatchObject({ admitted: true, surface: "firefox" });
  });
});

describe("commit rules (U13-P1 review hard rules)", () => {
  it("parallel requests for the same opening consume once and show at most one card", async () => {
    const { port, store, now } = await eligible();
    const { deps: d } = deps(store, now);
    const results = await Promise.all([admitRatingCard(d, request()), admitRatingCard(d, request()), admitRatingCard(d, request())]);
    expect(results.filter(r => r.admitted)).toHaveLength(1);
    expect(ledger(port)).toMatchObject({ rating: "consumed", reservation: null });
  });

  it("a rejected commit shows no card", async () => {
    const { port, store, now } = await eligible();
    const rejecting = Object.create(store) as InvitationLedgerStore;
    rejecting.commit = async () => false;
    const { deps: d } = deps(rejecting, now);
    expect(await admitRatingCard(d, request())).toEqual({ admitted: false, reason: "commit" });
    // The reservation stays uncommitted, so no card was ever visible; the next opening reclaims it.
    expect(ledger(port).rating).toBe("due");
  });

  it("a commit whose write fails shows no card", async () => {
    const { port, store, now } = await eligible();
    const failing = Object.create(store) as InvitationLedgerStore;
    failing.commit = async () => { throw new Error("storage unavailable"); };
    expect(await admitRatingCard(deps(failing, now).deps, request())).toEqual({ admitted: false, reason: "commit" });
    expect(ledger(port).rating).toBe("due");
  });

  it("commits before resolving: the caller never sees admitted while the ledger is uncommitted", async () => {
    const { port, store, now } = await eligible();
    const order: string[] = [];
    const observed = Object.create(store) as InvitationLedgerStore;
    observed.commit = async (reservation, at) => {
      order.push("commit:start");
      const ok = await store.commit(reservation, at);
      order.push(`commit:${ledger(port).rating}`);
      return ok;
    };
    const result = await admitRatingCard(deps(observed, now).deps, request());
    order.push(`result:${result.admitted}`);
    expect(order).toEqual(["commit:start", "commit:consumed", "result:true"]);
  });
});

describe("no telemetry", () => {
  it("every rating path makes no network request of its own", async () => {
    const network = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", network);
    const { store, now } = await eligible();
    for (const allowance of [ON, { allowed: false, reason: "off" }]) {
      await admitRatingCard(deps(store, now, { freshCheck: async () => allowance }).deps, request());
    }
    await admitRatingCard(deps(store, now).deps, request({ surface: "safari" }));
    expect(network).not.toHaveBeenCalled();
  });
});

describe("the anchor of a new ledger (clock behind at first run)", () => {
  it("is the later of the first-run time and the ledger's first recorded opening", () => {
    expect(newLedgerAnchor(T0 - 30 * DAY, T0)).toBe(T0);
    expect(newLedgerAnchor(T0 + DAY, T0)).toBe(T0 + DAY);
    expect(newLedgerAnchor(null, T0)).toBeNull();
  });

  it("a past-dated install record cannot shorten the seven-day wait of a new ledger", async () => {
    const port = new InMemoryInvitationLedgerPort();
    const store = new InvitationLedgerStore(port, PARAMETERS);
    const open = (opening: string, nowMs: number) =>
      recordRatingOpening(store, { installation: "install-a", anchorMs: T0 - 365 * DAY, opening, ordinary: true, nowMs, timeZone: ZONE });
    for (let i = 0; i < 3; i++) await open(`o${i + 1}`, T0 + i * DAY);
    expect(parseInvitationLedger(port.value)!.anchorMs).toBe(T0);
    await open("o4", T0 + 7 * DAY - 1);
    const early = await admitRatingCard({ store, freshCheck: async () => ON, now: () => T0 + 7 * DAY - 1, hostSurface: "chrome" }, request());
    expect(early).toEqual({ admitted: false, reason: "local" });
    await open("o5", T0 + 7 * DAY);
    const due = await admitRatingCard({ store, freshCheck: async () => ON, now: () => T0 + 7 * DAY, hostSurface: "chrome" },
      request({ opening: "o5" }));
    expect(due.admitted).toBe(true);
  });

  it("an existing ledger keeps its history: its anchor is never moved, and a missing one is adopted as it is", async () => {
    const port = new InMemoryInvitationLedgerPort();
    const store = new InvitationLedgerStore(port, PARAMETERS);
    await store.ensure("install-a", T0 - 30 * DAY);
    await recordRatingOpening(store, { installation: "x", anchorMs: T0 - 30 * DAY, opening: "o1", ordinary: true, nowMs: T0, timeZone: ZONE });
    expect(parseInvitationLedger(port.value)!.anchorMs).toBe(T0 - 30 * DAY);
    const waiting = new InMemoryInvitationLedgerPort();
    const pending = new InvitationLedgerStore(waiting, PARAMETERS);
    await pending.ensure("install-b", null);
    await recordRatingOpening(pending, { installation: "y", anchorMs: T0 - 30 * DAY, opening: "o1", ordinary: true, nowMs: T0, timeZone: ZONE });
    expect(parseInvitationLedger(waiting.value)!.anchorMs).toBe(T0 - 30 * DAY);
  });
});
