import { TIKTOK_ROUTE } from "../../content/tiktok-blocked-route.js";
import type {
  TikTokActionPort,
  TikTokBlockedIdentity,
  TikTokBlockedPresentation,
} from "./tiktok-blocked-presentation.js";

// The Chromium/Firefox host for the TikTok blocked page (D29). `tikTokBlockedPresentation` is the
// pure mapping from what the background has actually answered to the screen's presentation;
// `createTikTokBlockedHost` is the small state machine that asks the background and republishes.
// Caller obligations from tiktok-blocked-presentation.ts are met here:
//   • A confirm then cancel in one observation: the confirm wins (the page is already pending).
//   • Every settings click and every failed or cancelled request publishes a fresh observation,
//     so the screen's per-observation fences never hold a later deliberate action.
//   • An open attempt that does not finish (a failed, malformed or unanswered request, confirm or
//     reopen, or a confirmation the background let go) returns to blocked with the failure line
//     (owner decision 34). Its Try again is the ordinary request, so it always asks again.
// Nothing here writes settings, chooses a destination, or records analytics.

export type TikTokBlockedHostPhase =
  | "loading"
  | "blocked"
  | "confirmation"
  | "pending"
  | "granted"
  | "unavailable";

export interface TikTokBlockedHostState {
  readonly phase: TikTokBlockedHostPhase;
  /** Increases on every republish that must reopen the screen's fences. */
  readonly observation: number;
  /** The page's bound blocked-request id, tab id and document id (UI fences only). */
  readonly identity: TikTokBlockedIdentity;
  /** The last open attempt did not finish; shown only while the page is blocked. */
  readonly failed?: boolean;
}

export interface TikTokBlockedHostActions {
  requestConfirmation(): void;
  confirmOpen(): void;
  cancel(): void;
  settings(): void;
  reload(): void;
}

/** Pure mapping. Ports are ready only in the one phase where the background can honour them. */
export function tikTokBlockedPresentation(
  state: TikTokBlockedHostState,
  actions: TikTokBlockedHostActions,
): TikTokBlockedPresentation {
  const { phase } = state;
  const binding = {
    identity: { ...state.identity },
    observation: `${phase}:${state.observation}`,
    verified: phase !== "loading",
    fresh: true,
  };
  const port = (
    ready: boolean,
    request: () => void,
    idle: TikTokActionPort["status"] = phase === "loading" ? "unknown" : "unavailable",
  ): TikTokActionPort => ({
    ...binding,
    identity: { ...state.identity },
    status: ready ? "ready" : phase === "pending" ? "pending" : idle,
    ...(ready ? { request } : {}),
  });
  const supported = phase === "blocked" || phase === "confirmation" || phase === "pending" || phase === "granted";
  return {
    ...binding,
    host: "browser",
    state:
      phase === "confirmation"
        ? "confirmation"
        : phase === "pending"
          ? "pending"
          : phase === "granted"
            ? "reload"
            : "blocked",
    capability: {
      ...binding,
      identity: { ...state.identity },
      status: supported ? "supported" : phase === "loading" ? "unknown" : "unavailable",
    },
    requestConfirmation: port(phase === "blocked", actions.requestConfirmation),
    confirmOpen: port(phase === "confirmation", actions.confirmOpen),
    cancel: port(phase === "confirmation", actions.cancel),
    // Settings opens elsewhere and is honest in every settled phase except the open dialog.
    settings: port(phase !== "loading" && phase !== "confirmation", actions.settings),
    reload: port(phase === "granted", actions.reload),
    ...(phase === "granted"
      ? {
          outcome: {
            ...binding,
            identity: { ...state.identity },
            status: "granted-reload-needed" as const,
            // The background resolves the destination it bound to this page; no URL enters here.
            destinationValidated: true,
          },
        }
      : {}),
    ...(phase === "blocked" && state.failed
      ? { failure: { ...binding, identity: { ...state.identity }, status: "open-failed" as const } }
      : {}),
  };
}

export interface TikTokBlockedHostDeps {
  /** runtime.sendMessage to the background route; resolves with its reply. */
  readonly send: (message: { kind: string }) => Promise<unknown>;
  /** Opens Still settings (runtime.openOptionsPage). */
  readonly openSettings: () => void | Promise<void>;
  /** Replaces this page with the destination the background returned (location.replace). */
  readonly navigate: (url: string) => void;
  /** This page's bound request id (from its own URL) and a per-load document id. */
  readonly request: string;
  readonly document: string;
  /** Bound on each background answer. */
  readonly timeoutMs?: number;
  /** While the dialog is open, how often to confirm the background still holds it. */
  readonly heartbeatMs?: number;
}

export const TIKTOK_PAGE_TIMEOUT_MS = 15_000;
export const TIKTOK_HEARTBEAT_MS = 10_000;

const statusOf = (reply: unknown): unknown =>
  reply && typeof reply === "object" ? (reply as { status?: unknown }).status : undefined;

export function createTikTokBlockedHost(deps: TikTokBlockedHostDeps) {
  const listeners = new Set<(presentation: TikTokBlockedPresentation) => void>();
  let state: TikTokBlockedHostState = {
    phase: "loading",
    observation: 0,
    identity: { request: deps.request || "unbound", tab: "unknown", document: deps.document },
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  // Settings republishing must not invalidate work; deliberate workflow transitions must.
  // A phase alone cannot identify an intent after cancel -> retry returns to that same phase.
  let intent = 0;
  const current = (token: number) => !stopped && token === intent;

  const ask = async (kind: string): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => deps.send({ kind })),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), deps.timeoutMs ?? TIKTOK_PAGE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const actions: TikTokBlockedHostActions = {
    requestConfirmation() {
      if (stopped || state.phase !== "blocked") return;
      const token = ++intent;
      publish("pending");
      void ask(TIKTOK_ROUTE.request).then((reply) => {
        if (!current(token) || state.phase !== "pending") return;
        const status = statusOf(reply);
        if (status === "confirming") publish("confirmation");
        else if (status === "granted") publish("granted");
        else fail();
      });
    },
    confirmOpen() {
      if (stopped || state.phase !== "confirmation") return;
      const token = ++intent;
      // Any later cancel from the same observation is ignored: this page is now pending.
      publish("pending");
      void ask(TIKTOK_ROUTE.confirm).then((reply) => {
        if (!current(token) || state.phase !== "pending") return;
        if (statusOf(reply) === "granted") publish("granted");
        else fail();
      });
    },
    cancel() {
      if (stopped || state.phase !== "confirmation") return;
      intent += 1;
      publish("blocked");
      void ask(TIKTOK_ROUTE.cancel);
    },
    settings() {
      if (stopped || state.phase === "loading" || state.phase === "confirmation") return;
      void Promise.resolve()
        .then(() => { if (!stopped) return deps.openSettings(); })
        .catch(() => {});
      // Same phase, fresh observation: the settings fence never holds the next deliberate action.
      // A failure line already on the page stays; settings opening elsewhere doesn't resolve it.
      publish(state.phase, undefined, state.failed);
    },
    reload() {
      if (stopped || state.phase !== "granted") return;
      const token = ++intent;
      publish("pending");
      void ask(TIKTOK_ROUTE.open).then((reply) => {
        if (!current(token) || state.phase !== "pending") return;
        const url = reply && typeof reply === "object" ? (reply as { url?: unknown }).url : undefined;
        if (statusOf(reply) === "open" && typeof url === "string") deps.navigate(url);
        else fail();
      });
    },
  };

  const fail = () => publish("blocked", undefined, true);

  function publish(phase: TikTokBlockedHostPhase, tab?: string, failed = false): void {
    if (stopped) return;
    state = {
      phase,
      observation: state.observation + 1,
      identity: tab ? { ...state.identity, tab } : state.identity,
      ...(failed && phase === "blocked" ? { failed: true } : {}),
    };
    clearInterval(heartbeat);
    heartbeat = undefined;
    if (phase === "confirmation") {
      const token = intent;
      heartbeat = setInterval(() => {
        void ask(TIKTOK_ROUTE.confirming).then((reply) => {
          // The background let this confirmation go (timeout, restart): close the dialog.
          if (current(token) && state.phase === "confirmation" && statusOf(reply) !== "confirming") fail();
        });
      }, deps.heartbeatMs ?? TIKTOK_HEARTBEAT_MS);
    }
    const presentation = tikTokBlockedPresentation(state, actions);
    for (const listener of listeners) listener(presentation);
  }

  return {
    actions,
    state: () => state,
    current: () => tikTokBlockedPresentation(state, actions),
    subscribe(listener: (presentation: TikTokBlockedPresentation) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(): Promise<void> {
      if (stopped) return;
      const token = ++intent;
      const reply = await ask(TIKTOK_ROUTE.screen);
      if (!current(token)) return;
      const status = statusOf(reply);
      const tab = reply && typeof reply === "object" ? (reply as { tab?: unknown }).tab : undefined;
      publish(
        status === "granted" ? "granted" : status === "blocked" ? "blocked" : "unavailable",
        typeof tab === "number" ? String(tab) : undefined,
      );
    },
    stop(unavailable = false): void {
      if (unavailable) publish("unavailable");
      stopped = true;
      intent += 1;
      clearInterval(heartbeat);
      listeners.clear();
    },
  };
}
