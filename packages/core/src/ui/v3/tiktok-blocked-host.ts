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
      if (state.phase !== "blocked") return;
      publish("pending");
      void ask(TIKTOK_ROUTE.request).then((reply) => {
        if (state.phase !== "pending") return;
        const status = statusOf(reply);
        publish(status === "confirming" ? "confirmation" : status === "granted" ? "granted" : "blocked");
      });
    },
    confirmOpen() {
      if (state.phase !== "confirmation") return;
      // Any later cancel from the same observation is ignored: this page is now pending.
      publish("pending");
      void ask(TIKTOK_ROUTE.confirm).then((reply) => {
        if (state.phase === "pending") publish(statusOf(reply) === "granted" ? "granted" : "blocked");
      });
    },
    cancel() {
      if (state.phase !== "confirmation") return;
      publish("blocked");
      void ask(TIKTOK_ROUTE.cancel);
    },
    settings() {
      if (state.phase === "loading" || state.phase === "confirmation") return;
      void Promise.resolve()
        .then(() => deps.openSettings())
        .catch(() => {});
      // Same phase, fresh observation: the settings fence never holds the next deliberate action.
      publish(state.phase);
    },
    reload() {
      if (state.phase !== "granted") return;
      publish("pending");
      void ask(TIKTOK_ROUTE.open).then((reply) => {
        if (state.phase !== "pending") return;
        const url = reply && typeof reply === "object" ? (reply as { url?: unknown }).url : undefined;
        if (statusOf(reply) === "open" && typeof url === "string") deps.navigate(url);
        else publish("blocked");
      });
    },
  };

  function publish(phase: TikTokBlockedHostPhase, tab?: string): void {
    if (stopped) return;
    state = {
      phase,
      observation: state.observation + 1,
      identity: tab ? { ...state.identity, tab } : state.identity,
    };
    clearInterval(heartbeat);
    heartbeat = undefined;
    if (phase === "confirmation") {
      heartbeat = setInterval(() => {
        void ask(TIKTOK_ROUTE.confirming).then((reply) => {
          // The background let this confirmation go (timeout, restart): close the dialog.
          if (state.phase === "confirmation" && statusOf(reply) !== "confirming") publish("blocked");
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
      const reply = await ask(TIKTOK_ROUTE.screen);
      const status = statusOf(reply);
      const tab = reply && typeof reply === "object" ? (reply as { tab?: unknown }).tab : undefined;
      publish(
        status === "granted" ? "granted" : status === "blocked" ? "blocked" : "unavailable",
        typeof tab === "number" ? String(tab) : undefined,
      );
    },
    stop(): void {
      stopped = true;
      clearInterval(heartbeat);
      listeners.clear();
    },
  };
}
