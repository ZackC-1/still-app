// The Safari pending cover (owner decision V3-D-052, approved as CP-038 in V3-D-198, with the
// redirect-in-flight extension ruled for U7-W3). It hides a page Still is about to send elsewhere,
// so a blocked short-form page does not flash before its redirect, for at most 1.5 seconds.
//
// What it is: one class on <html> and one Still-owned stylesheet. The page's own content becomes
// transparent, so what shows is the page's own background. It adds no colour, words, logo or
// spinner (the cover's appearance is not a design-approved surface; it must stay text-free).
//
// Two independent limits keep it from ever leaving a blank page:
// - a timer per cover, measured from when that cover appeared and never extended, plus a check on
//   page show, visibility and focus for tabs whose timers were frozen;
// - the stylesheet itself: the opacity comes from a 1.5-second animation with no fill, so it stops
//   applying on its own even if this script's world dies with the class still set.

export const PENDING_COVER_CLASS = "still-pending-cover";
export const PENDING_COVER_CEILING_MS = 1_500;
/** Marks the Still-owned stylesheet; nothing on the page reads it. */
export const PENDING_COVER_STYLE_ATTRIBUTE = "data-still-pending-cover";
/**
 * The whole visual. Keyed only on the class; `fill-mode: none` is what makes it expire on its own
 * after the active 1.5 seconds. `!important` on `animation` keeps a site's own body animation from
 * displacing it; the animated opacity outranks the site's ordinary opacity declarations. Written as
 * plain literals so a build that never uses the cover drops this module whole; a test pins the text
 * to PENDING_COVER_CLASS and PENDING_COVER_CEILING_MS.
 */
export const PENDING_COVER_CSS =
  "@keyframes still-pending-cover{from,to{opacity:0}}" +
  "html.still-pending-cover>body{animation:still-pending-cover 1500ms linear 0s 1 normal none running!important}";

/** Why a cover was shown: settings still loading (V3-D-052), or a redirect Still has issued. */
export type PendingCoverPhase = "pending" | "redirecting";

/** Why a cover was removed (test and diagnostic observation only; nothing is reported anywhere). */
export type PendingCoverRelease =
  | "allowed"
  | "settings-unavailable"
  | "superseded"
  | "redirect-failed"
  | "ceiling"
  | "restored"
  | "stopped";

/** Releases that stand down once a redirect is in flight: that navigation cannot be undone. */
const DECISION_RELEASES: ReadonlySet<PendingCoverRelease> = new Set(["allowed", "settings-unavailable", "superseded"]);

export interface PendingCoverEvents {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface PendingCoverDeps {
  readonly doc: Document;
  /** The page's window, for `pageshow` and `focus`. */
  readonly win: PendingCoverEvents;
  readonly ceilingMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  /** Test-only observation. */
  readonly onRelease?: (why: PendingCoverRelease, phase: PendingCoverPhase) => void;
}

export interface PendingCover {
  /**
   * Cover the page now and return this cover's token. While a cover is already up, it returns the
   * same token and keeps the original deadline: the ceiling is never extended.
   */
  show(phase: PendingCoverPhase): number;
  /** The redirect for `token` was issued: keep the cover through the navigation (to the ceiling). */
  commit(token: number): void;
  /** Remove the cover only if `token` is still the current one; stale callbacks do nothing. */
  release(token: number, why: PendingCoverRelease): void;
  /** Whether a cover is up right now. */
  active(): boolean;
  /** Teardown: remove the cover and everything it attached. */
  stop(): void;
}

export function createPendingCover(deps: PendingCoverDeps): PendingCover {
  const { doc, win } = deps;
  const ceiling = deps.ceilingMs ?? PENDING_COVER_CEILING_MS;
  const now = deps.now ?? (() => performance.now());
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let token = 0;
  let current: {
    readonly token: number;
    readonly shownAt: number;
    readonly phase: PendingCoverPhase;
    readonly timer: unknown;
    committed: boolean;
  } | null = null;
  let style: HTMLStyleElement | null = null;
  let stopped = false;

  const onPageShow = (event: Event): void => {
    if (!current) return;
    if ((event as PageTransitionEvent).persisted === true) release(current.token, "restored");
    else expireIfDue();
  };
  const expireIfDue = (): void => {
    if (current && now() - current.shownAt >= ceiling) release(current.token, "ceiling");
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === "visible") expireIfDue();
  };
  const listen = (on: boolean): void => {
    const method = on ? "addEventListener" : "removeEventListener";
    win[method]("pageshow", onPageShow);
    win[method]("focus", expireIfDue);
    doc[method]("visibilitychange", onVisibility);
  };

  const release = (target: number, why: PendingCoverRelease): void => {
    if (!current || current.token !== target) return;
    if (current.committed && DECISION_RELEASES.has(why)) return;
    const { timer, phase } = current;
    current = null;
    clearTimer(timer);
    listen(false);
    doc.documentElement?.classList.remove(PENDING_COVER_CLASS);
    style?.remove();
    style = null;
    deps.onRelease?.(why, phase);
  };

  return {
    show(phase) {
      if (stopped) return 0;
      if (current) return current.token;
      const root = doc.documentElement;
      if (!root) return 0;
      token += 1;
      const mine = token;
      style = doc.createElement("style");
      style.setAttribute(PENDING_COVER_STYLE_ATTRIBUTE, "");
      style.textContent = PENDING_COVER_CSS;
      (doc.head ?? root).append(style);
      root.classList.add(PENDING_COVER_CLASS);
      current = {
        token: mine,
        shownAt: now(),
        phase,
        timer: setTimer(() => release(mine, "ceiling"), ceiling),
        committed: false,
      };
      listen(true);
      return mine;
    },
    commit(target) {
      if (current && current.token === target) current.committed = true;
    },
    release,
    active: () => current !== null,
    stop() {
      if (current) {
        current.committed = false;
        release(current.token, "stopped");
      }
      stopped = true;
    },
  };
}
