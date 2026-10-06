import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPendingCover,
  PENDING_COVER_CEILING_MS,
  PENDING_COVER_CLASS,
  PENDING_COVER_CSS,
  PENDING_COVER_STYLE_ATTRIBUTE,
  type PendingCoverRelease,
} from "../pending-cover.js";

// The Safari pending cover (V3-D-052 / V3-D-198). Timers and the clock are injected: `fire` runs a
// timer callback even after it was "cleared", which is exactly what a stale callback looks like.

let clock = 0;
let timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
const releases: PendingCoverRelease[] = [];
const created: Array<ReturnType<typeof createPendingCover>> = [];

function cover(options: { frozenTimers?: boolean } = {}) {
  const made = createPendingCover({
    doc: document,
    win: window,
    now: () => clock,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      if (!options.frozenTimers) timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
    onRelease: (why) => releases.push(why),
  });
  created.push(made);
  return made;
}
/** Advance the clock and run every live timer that is due, like a browser event loop. */
function advance(ms: number) {
  clock += ms;
  for (const timer of timers.splice(0)) {
    if (timer.cleared) continue;
    if (timer.ms <= clock) timer.callback();
    else timers.push(timer);
  }
}
const covered = () => document.documentElement.classList.contains(PENDING_COVER_CLASS);
const styles = () => document.querySelectorAll(`style[${PENDING_COVER_STYLE_ATTRIBUTE}]`).length;
let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

afterEach(() => {
  for (const made of created.splice(0)) made.stop();
  clock = 0;
  timers = [];
  releases.splice(0);
  visibility = "visible";
  document.head.innerHTML = "";
  document.documentElement.className = "";
  vi.restoreAllMocks();
});

describe("pending cover", () => {
  it("shows with one owned stylesheet and is gone at exactly the 1.5 s ceiling", () => {
    const c = cover();
    c.show("pending");
    expect(covered()).toBe(true);
    expect(styles()).toBe(1);
    advance(PENDING_COVER_CEILING_MS - 1);
    expect(covered()).toBe(true);
    advance(1);
    expect(covered()).toBe(false);
    expect(styles()).toBe(0);
    expect(releases).toEqual(["ceiling"]);
    expect(PENDING_COVER_CEILING_MS).toBe(1500);
  });

  it("an explicit release removes the class and the stylesheet at once", () => {
    const c = cover();
    const token = c.show("pending");
    c.release(token, "allowed");
    expect(covered()).toBe(false);
    expect(styles()).toBe(0);
    expect(c.active()).toBe(false);
  });

  it("a stale callback never removes a newer cover", () => {
    const c = cover();
    const first = c.show("pending");
    const firstTimer = timers[0]!;
    c.release(first, "allowed");
    const second = c.show("redirecting");
    expect(second).not.toBe(first);
    // The first cover's watchdog firing late (a frozen timer resuming) and a late release.
    firstTimer.callback();
    c.release(first, "superseded");
    expect(covered()).toBe(true);
    expect(c.active()).toBe(true);
  });

  it("a second show while covered keeps the original deadline (the ceiling is never extended)", () => {
    const c = cover();
    const token = c.show("pending");
    advance(1_000);
    expect(c.show("redirecting")).toBe(token);
    advance(PENDING_COVER_CEILING_MS - 1_000);
    expect(covered()).toBe(false);
  });

  it("commit keeps the cover through the navigation but not past the ceiling", () => {
    const c = cover();
    const token = c.show("redirecting");
    c.commit(token);
    for (const why of ["allowed", "superseded", "settings-unavailable"] as const) c.release(token, why);
    expect(covered()).toBe(true);
    advance(PENDING_COVER_CEILING_MS);
    expect(covered()).toBe(false);
    expect(releases).toEqual(["ceiling"]);
  });

  it.each(["redirect-failed", "restored"] as const)("a committed cover still yields to %s", (why) => {
    const c = cover();
    const token = c.show("redirecting");
    c.commit(token);
    c.release(token, why);
    expect(covered()).toBe(false);
  });

  it("with frozen timers, returning to the tab past the deadline removes the cover", () => {
    const c = cover({ frozenTimers: true });
    c.show("pending");
    clock = PENDING_COVER_CEILING_MS - 1;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(covered()).toBe(true);
    clock = PENDING_COVER_CEILING_MS;
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(covered()).toBe(true); // a hidden tab is not looked at
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(covered()).toBe(false);
    expect(releases).toEqual(["ceiling"]);
  });

  it.each(["focus", "pageshow"])("%s past the deadline also removes a cover whose timer never ran", (type) => {
    const c = cover({ frozenTimers: true });
    c.show("pending");
    clock = PENDING_COVER_CEILING_MS + 5;
    window.dispatchEvent(new Event(type));
    expect(covered()).toBe(false);
  });

  it("a back/forward cache restore removes the cover; pagehide never does", () => {
    const c = cover();
    const token = c.show("redirecting");
    c.commit(token);
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    expect(covered()).toBe(true);
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(covered()).toBe(false);
    expect(releases).toEqual(["restored"]);
  });

  it("stop removes the cover, detaches every listener and refuses later shows", () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const docAdded = vi.spyOn(document, "addEventListener");
    const docRemoved = vi.spyOn(document, "removeEventListener");
    const c = cover();
    const token = c.show("redirecting");
    c.commit(token);
    c.stop();
    expect(covered()).toBe(false);
    expect(styles()).toBe(0);
    expect(releases).toEqual(["stopped"]);
    expect(removed.mock.calls.map(([type]) => type).sort()).toEqual(added.mock.calls.map(([type]) => type).sort());
    expect(docRemoved.mock.calls.map(([type]) => type)).toEqual(docAdded.mock.calls.map(([type]) => type));
    expect(c.show("pending")).toBe(0);
    expect(covered()).toBe(false);
  });

  it("nothing is attached while no cover is up", () => {
    const added = vi.spyOn(window, "addEventListener");
    cover();
    expect(added).not.toHaveBeenCalled();
    expect(styles()).toBe(0);
  });

  it("the stylesheet is text-free, keyed only on the class, and expires on its own", () => {
    expect(PENDING_COVER_CSS).toBe(
      `@keyframes ${PENDING_COVER_CLASS}{from,to{opacity:0}}` +
        `html.${PENDING_COVER_CLASS}>body{animation:${PENDING_COVER_CLASS} ${PENDING_COVER_CEILING_MS}ms linear 0s 1 normal none running!important}`,
    );
    // No fill mode that would keep the effect after the active duration, no colour, no content.
    expect(PENDING_COVER_CSS).not.toMatch(/forwards|both|backwards|color|background|content|::/);
  });
});
