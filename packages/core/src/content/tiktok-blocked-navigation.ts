import { renderPlaceholder, STILL_BLOCKED_LINE } from "../rules/engine.js";
import { TIKTOK_ROUTE } from "./tiktok-blocked-route.js";

// The content-script half of the TikTok blocked page (D29). When the committed settings block a
// top-level TikTok document, this asks the background once, with a body that names nothing (the
// background reads the browser's own sender), and keeps the page out of sight while it answers:
//   • "allowed": this living tab holds a confirmed one-tab allowance, so TikTok stays untouched.
//   • "redirected": the background is sending this tab to the extension's blocked page.
//   • anything else, including no answer in time: the existing in-page block, so a failure can
//     never leave TikTok open.
// It writes no settings and records nothing.

export type TikTokBlockedPageState = "allowed" | "owned" | "fallback";

export interface TikTokBlockedNavigationDeps {
  readonly doc: Document;
  /** Sends `message` to the background and resolves with its reply. */
  readonly send: (message: { kind: string; traversal?: true }) => Promise<unknown>;
  /** True when this document was reached by Back/Forward (performance navigation type). */
  readonly traversal?: () => boolean;
  /** Bound on the background's answer. */
  readonly timeoutMs?: number;
  /** How long a redirected page may stay before falling back to the in-page block. */
  readonly redirectGraceMs?: number;
  readonly blockedLine?: string;
}

export interface TikTokBlockedNavigation {
  /** Legacy lane, current document: leave it ("allowed"), keep it hidden ("owned"), or block it here. */
  current(): TikTokBlockedPageState;
  /** Format-2 lane port (ContentScriptDeps.handleBlockedNavigation): consume unless allowed. */
  consume(target: URL): boolean;
  stop(): void;
}

export const TIKTOK_HOLD_STYLE_ID = "still-tiktok-hold";
export const TIKTOK_REPLY_TIMEOUT_MS = 10_000;
export const TIKTOK_REDIRECT_GRACE_MS = 5_000;

export function backForwardNavigation(): boolean {
  try {
    const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    return entry?.type === "back_forward";
  } catch {
    return false;
  }
}

export function createTikTokBlockedNavigation(deps: TikTokBlockedNavigationDeps): TikTokBlockedNavigation {
  const { doc } = deps;
  const line = deps.blockedLine ?? STILL_BLOCKED_LINE;
  let state: "idle" | "pending" | "redirected" | "allowed" | "fallback" = "idle";
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const view = doc.defaultView;
  const now = () => state;

  const hold = () => {
    if (doc.getElementById(TIKTOK_HOLD_STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = TIKTOK_HOLD_STYLE_ID;
    style.textContent = "html{visibility:hidden!important}";
    (doc.head ?? doc.documentElement)?.appendChild(style);
  };
  const release = () => doc.getElementById(TIKTOK_HOLD_STYLE_ID)?.remove();

  // The in-page block needs a body; a very early answer waits for one.
  const renderBlock = () => {
    if (doc.body) renderPlaceholder(doc, line);
    else doc.addEventListener("DOMContentLoaded", () => renderPlaceholder(doc, line), { once: true });
  };
  const fallback = () => {
    if (stopped || state === "allowed") return;
    clearTimeout(timer);
    state = "fallback";
    release();
    renderBlock();
  };
  // A page restored from the back/forward cache never re-runs this script; never leave it hidden.
  const onPageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted && state === "redirected") fallback();
  };

  function start(): void {
    if (state !== "idle" || stopped) return;
    state = "pending";
    hold();
    const traversal = deps.traversal?.() === true;
    let settled = false;
    const finish = (reply: unknown) => {
      if (settled || stopped) return;
      settled = true;
      clearTimeout(timer);
      const status = reply && typeof reply === "object" ? (reply as { status?: unknown }).status : undefined;
      if (status === "allowed") {
        state = "allowed";
        release();
      } else if (status === "redirected") {
        state = "redirected";
        view?.addEventListener("pageshow", onPageShow);
        timer = setTimeout(fallback, deps.redirectGraceMs ?? TIKTOK_REDIRECT_GRACE_MS);
      } else fallback();
    };
    timer = setTimeout(() => finish(null), deps.timeoutMs ?? TIKTOK_REPLY_TIMEOUT_MS);
    try {
      void Promise.resolve(
        deps.send(traversal ? { kind: TIKTOK_ROUTE.blocked, traversal: true } : { kind: TIKTOK_ROUTE.blocked }),
      ).then(finish, () => finish(null));
    } catch {
      finish(null);
    }
  }

  return {
    current() {
      if (state === "allowed") return "allowed";
      start();
      // Re-read: a synchronous send failure falls back within start(); answers arrive later.
      return now() === "fallback" ? "fallback" : "owned";
    },
    consume(_target: URL) {
      if (state === "allowed") return false;
      start();
      return true;
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      view?.removeEventListener("pageshow", onPageShow);
      // An invalidated script can no longer finish the request; never leave the page hidden.
      if (state === "pending" || state === "redirected") {
        release();
        renderBlock();
      }
    },
  };
}
