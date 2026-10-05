import type {
  SettingsV2,
  SignedRuleSet,
  SignedRuleSetV2,
  StillSettings,
} from "@still/shared-types";
import { createEnginePageSession, type EngineOptions } from "../rules/engine.js";

// The background half of the TikTok blocked page (D29) for Chromium/Firefox. It owns three jobs
// and nothing else:
//   • A top-level TikTok document whose committed settings block it is sent to the extension's
//     own blocked page, unless its living tab already holds a confirmed one-tab allowance.
//   • The blocked page's "Open TikTok this time" runs in two trusted steps from that page: a
//     request opens one bounded confirmation for that exact page document, and only a later
//     confirm from the same document lets the tab authority finish the allowance.
//   • A granted page asks for its original destination, which only this route remembers.
// It never writes saved or synced settings and records no analytics. Every wait on storage, the
// browser, settings or the person is bounded, so a stalled answer can only end in "not allowed".

/** Runtime message kinds. Bodies carry no URL, tab or document: senders are read from the browser. */
export const TIKTOK_ROUTE = {
  /** Content script in a top-level TikTok document that the committed settings block. */
  blocked: "still:tiktok-blocked",
  /** Blocked page: what this page document may show. */
  screen: "still:tiktok-screen",
  /** Blocked page: "Open TikTok this time" pressed; opens one confirmation for this document. */
  request: "still:tiktok-request",
  /** Blocked page: the confirmation dialog is still open (also keeps the worker awake). */
  confirming: "still:tiktok-confirming",
  /** Blocked page: the person confirmed in the dialog. */
  confirm: "still:tiktok-confirm",
  /** Blocked page: the person kept TikTok closed. */
  cancel: "still:tiktok-cancel",
  /** Blocked page: "Reload page" after a grant; answers with the original destination. */
  open: "still:tiktok-open",
} as const;

export type TiktokRouteReply =
  | { readonly status: "allowed" | "redirected" | "held" }
  | { readonly status: "blocked" | "granted" | "unavailable"; readonly tab?: number }
  | { readonly status: "confirming" | "failed" | "cancelled" | "idle" }
  | { readonly status: "open"; readonly url: string };

/** The actual browser MessageSender subset; never a message body field. */
export interface TiktokRouteSender {
  readonly id?: string;
  readonly url?: string;
  readonly frameId?: number;
  readonly documentId?: string;
  readonly tab?: { readonly id?: number };
}

/** The one-tab authority (packages/ext-chromium/lib/tiktok-tab-authority.ts) as this route uses it. */
export interface TiktokRouteAuthority {
  readonly supported: boolean;
  allow(sender: TiktokRouteSender): Promise<boolean>;
  isAllowed(sender: TiktokRouteSender): Promise<boolean>;
  stop(): Promise<void>;
}

/** Bound producers handed to the authority at construction. Every one always settles. */
export interface TiktokRouteHooks {
  resolveOriginalTarget(sender: Readonly<TiktokRouteSender>): Promise<string | null>;
  confirm(context: { readonly tabId: number }): Promise<boolean>;
  /** The route's committed-settings read, bounded (rejects after the wait limit). */
  readCommitted(): Promise<TiktokCommittedSnapshot | null>;
  /** The route's session area, each call bounded (rejects after the wait limit). */
  readonly session?: TiktokRouteSession;
}

export interface TiktokRouteSession {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface TiktokRouteTabs {
  get(id: number): Promise<{ readonly id?: number; readonly url?: string; readonly pendingUrl?: string }>;
  update(id: number, properties: { url: string; loadReplace?: boolean }): Promise<unknown>;
  readonly onRemoved: {
    addListener(listener: (id: number) => void): void;
    removeListener(listener: (id: number) => void): void;
  };
  readonly onReplaced: {
    addListener(listener: (added: number, removed: number) => void): void;
    removeListener(listener: (added: number, removed: number) => void): void;
  };
}

export interface TiktokCommittedSnapshot {
  readonly settings: StillSettings | SettingsV2;
  readonly options: EngineOptions;
}

export interface TiktokBlockedRouteDeps {
  readonly runtimeId: string;
  /** runtime.getURL("") */
  readonly extensionOrigin: string;
  /** runtime.getURL of the packaged blocked page. */
  readonly pageUrl: string;
  /** Extension-only browser session storage (cleared when the browser closes). */
  readonly session?: TiktokRouteSession;
  readonly tabs?: TiktokRouteTabs;
  /** The rule set this host's content scripts evaluate, so both sides agree on "blocked". */
  readonly ruleSet: SignedRuleSet | SignedRuleSetV2;
  /** Existing committed settings; null or a failed read holds every action. */
  readonly readCommitted: () => Promise<TiktokCommittedSnapshot | null>;
  /** True when the browser can re-prove the exact blocked page document (runtime.getContexts). */
  readonly canVerifyDocuments: boolean;
  /** Firefox: replace the blocked TikTok history entry instead of adding one. */
  readonly replaceHistory?: boolean;
  readonly createAuthority: (hooks: TiktokRouteHooks) => TiktokRouteAuthority;
  readonly randomId: () => string;
  readonly limits?: {
    /** Each storage/browser/settings wait. */
    readonly waitMs?: number;
    /** How long one opened confirmation stays answerable. */
    readonly confirmMs?: number;
    /** Whole-answer budgets for content-script and blocked-page messages. */
    readonly contentAnswerMs?: number;
    readonly pageAnswerMs?: number;
  };
}

export const TIKTOK_WAIT_MS = 3_000;
export const TIKTOK_CONFIRM_MS = 120_000;
/** Whole-answer budgets, each shorter than its sender's own bound (content 10 s, page 15 s). */
export const TIKTOK_CONTENT_ANSWER_MS = 8_000;
export const TIKTOK_PAGE_ANSWER_MS = 12_000;

/** Settles with the operation, or rejects once `ms` passes. Never leaves a wait unbounded. */
export function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Still TikTok wait timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function isTiktokPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      (url.hostname === "tiktok.com" || url.hostname.endsWith(".tiktok.com"))
    );
  } catch {
    return false;
  }
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const originKey = (tabId: number) => `still:tiktok-origin:${tabId}`;

interface PendingConfirmation {
  readonly documentId: string;
  settled: boolean;
  invoked: boolean;
  readonly answer: Promise<boolean>;
  readonly asked: Promise<void>;
  allow: Promise<boolean>;
  settle(value: boolean): void;
  markAsked(): void;
}

export function createTiktokBlockedRoute(deps: TiktokBlockedRouteDeps) {
  const waitMs = deps.limits?.waitMs ?? TIKTOK_WAIT_MS;
  const confirmMs = deps.limits?.confirmMs ?? TIKTOK_CONFIRM_MS;
  const { tabs } = deps;
  const bound = <T>(operation: () => Promise<T>): Promise<T> =>
    withTimeout(Promise.resolve().then(operation), waitMs);
  const area = deps.session;
  const session: TiktokRouteSession | undefined = area && {
    get: (key) => bound(() => area.get(key)),
    set: (items) => bound(() => area.set(items)),
    remove: (key) => bound(() => area.remove(key)),
  };
  const readCommitted = () => bound(() => deps.readCommitted());
  const wired = !!session && !!tabs;
  const engine = createEnginePageSession(deps.ruleSet);
  const page = new URL(deps.pageUrl);
  const pending = new Map<number, PendingConfirmation>();
  let stopped = false;

  const tabOf = (sender: TiktokRouteSender): number | null => {
    const id = sender.tab?.id;
    return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : null;
  };

  function contentSender(sender: TiktokRouteSender): boolean {
    return (
      sender.id === deps.runtimeId &&
      sender.frameId === 0 &&
      tabOf(sender) !== null &&
      typeof sender.url === "string" &&
      !sender.url.startsWith(deps.extensionOrigin) &&
      isTiktokPageUrl(sender.url)
    );
  }

  function requestIdOf(sender: TiktokRouteSender): string | null {
    try {
      const actual = new URL(sender.url!);
      const id = actual.searchParams.get("r");
      return actual.origin === page.origin &&
        actual.pathname === page.pathname &&
        typeof id === "string" &&
        REQUEST_ID.test(id)
        ? id
        : null;
    } catch {
      return null;
    }
  }

  function screenSender(sender: TiktokRouteSender): boolean {
    return (
      sender.id === deps.runtimeId &&
      sender.frameId === 0 &&
      tabOf(sender) !== null &&
      typeof sender.url === "string" &&
      sender.url.startsWith(deps.extensionOrigin) &&
      requestIdOf(sender) !== null
    );
  }

  /** The browser can re-prove this exact page document, so an allowance can be bound to it. */
  const capable = (sender: TiktokRouteSender) =>
    wired &&
    deps.canVerifyDocuments &&
    authority.supported &&
    typeof sender.documentId === "string" &&
    sender.documentId.length > 0;

  async function resolveOriginalTarget(sender: Readonly<TiktokRouteSender>): Promise<string | null> {
    if (stopped || !session || !screenSender(sender)) return null;
    const tabId = tabOf(sender)!;
    const id = requestIdOf(sender);
    try {
      const stored = (await session.get(originKey(tabId)))[originKey(tabId)];
      if (!stored || typeof stored !== "object") return null;
      const { request, target } = stored as { request?: unknown; target?: unknown };
      return request === id && typeof target === "string" && isTiktokPageUrl(target) ? target : null;
    } catch {
      return null;
    }
  }

  function confirm(context: { readonly tabId: number }): Promise<boolean> {
    const open = pending.get(context.tabId);
    if (stopped || !open || open.settled) return Promise.resolve(false);
    open.markAsked();
    return open.answer;
  }

  const authority = deps.createAuthority({ resolveOriginalTarget, confirm, readCommitted, session });

  function settlePending(tabId: number, keepDocument?: string): void {
    const open = pending.get(tabId);
    if (!open || open.documentId === keepDocument) return;
    open.settle(false);
    pending.delete(tabId);
  }

  function openConfirmation(tabId: number, documentId: string): PendingConfirmation {
    settlePending(tabId);
    let answer!: (value: boolean) => void;
    let asked!: () => void;
    const open: PendingConfirmation = {
      documentId,
      settled: false,
      invoked: false,
      answer: new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
      asked: new Promise<void>((resolve) => {
        asked = resolve;
      }),
      allow: Promise.resolve(false),
      settle(value) {
        if (open.settled) return;
        open.settled = true;
        clearTimeout(timer);
        answer(value);
      },
      markAsked() {
        open.invoked = true;
        asked();
      },
    };
    // An unanswered confirmation ends as "not allowed"; it can never hold the tab queue or stop().
    const timer = setTimeout(() => open.settle(false), confirmMs);
    pending.set(tabId, open);
    return open;
  }

  async function blockedHere(target: string): Promise<boolean> {
    const snapshot = await readCommitted();
    if (!snapshot) return false;
    const decision = engine.evaluate(snapshot.settings, new URL(target), snapshot.options);
    return engine.activeServiceId() === "tiktok" && decision.kind === "placeholder" && decision.blocked === true;
  }

  async function onBlocked(sender: TiktokRouteSender, traversal: boolean): Promise<TiktokRouteReply> {
    if (!wired || stopped) return { status: "held" };
    const tabId = tabOf(sender)!;
    // This tab now shows a TikTok document, so any blocked page that opened a confirmation here is
    // gone. Retire it first: otherwise this answer would queue behind it for up to the whole
    // confirmation bound and then act long after the person moved on.
    settlePending(tabId);
    const deadline = Date.now() + (deps.limits?.contentAnswerMs ?? TIKTOK_CONTENT_ANSWER_MS);
    // Before each browser-visible write: the answer is still wanted and the tab still shows the
    // exact document this request validated. A late or moved request writes nothing.
    const current = async (): Promise<boolean> => {
      if (stopped || Date.now() >= deadline) return false;
      const tab = await bound(() => tabs!.get(tabId));
      return (
        !stopped &&
        Date.now() < deadline &&
        tab.id === tabId &&
        tab.url === sender.url &&
        (!tab.pendingUrl || tab.pendingUrl === sender.url)
      );
    };
    if (await authority.isAllowed(sender).catch(() => false)) return { status: "allowed" };
    // Back/Forward into a blocked entry stays on this page's own block instead of re-sending the
    // person forward to the blocked page, which would trap Back.
    if (traversal || !(await blockedHere(sender.url!)) || !(await current())) return { status: "held" };
    const request = deps.randomId();
    if (!REQUEST_ID.test(request)) return { status: "held" };
    await session!.set({ [originKey(tabId)]: { request, target: sender.url } });
    if (!(await current())) {
      // Never leave an address behind for a redirect that will not happen.
      await session!.remove(originKey(tabId)).catch(() => {});
      return { status: "held" };
    }
    const url = new URL(deps.pageUrl);
    url.searchParams.set("r", request);
    await bound(() =>
      tabs!.update(tabId, deps.replaceHistory ? { url: url.href, loadReplace: true } : { url: url.href }),
    );
    return { status: "redirected" };
  }

  async function onScreen(sender: TiktokRouteSender): Promise<TiktokRouteReply> {
    const tab = tabOf(sender)!;
    // A newly loaded page document retires any confirmation another document opened in this tab.
    settlePending(tab, sender.documentId);
    if (!capable(sender) || (await resolveOriginalTarget(sender)) === null)
      return { status: "unavailable", tab };
    // No confirmation is open, so this succeeds only for an allowance this tab already completed.
    return { status: (await authority.allow(sender)) ? "granted" : "blocked", tab };
  }

  async function onRequest(sender: TiktokRouteSender): Promise<TiktokRouteReply> {
    if (!capable(sender)) return { status: "failed" };
    const tabId = tabOf(sender)!;
    const current = pending.get(tabId);
    if (current && !current.settled && current.documentId === sender.documentId && current.invoked)
      return { status: "confirming" };
    const open = openConfirmation(tabId, sender.documentId!);
    open.allow = authority
      .allow(sender)
      .catch(() => false)
      .finally(() => {
        open.settle(false);
        if (pending.get(tabId) === open) pending.delete(tabId);
      });
    const first = await Promise.race([
      open.asked.then(() => "confirming" as const),
      open.allow.then((granted) => (granted ? ("granted" as const) : ("failed" as const))),
    ]);
    return { status: first };
  }

  async function onConfirm(sender: TiktokRouteSender): Promise<TiktokRouteReply> {
    const tabId = tabOf(sender)!;
    const open = pending.get(tabId);
    // Only the same page document that opened this confirmation may answer it, exactly once.
    if (!capable(sender) || !open || open.settled || !open.invoked || open.documentId !== sender.documentId)
      return { status: "failed" };
    open.settle(true);
    return { status: (await open.allow) ? "granted" : "failed" };
  }

  async function onCancel(sender: TiktokRouteSender): Promise<TiktokRouteReply> {
    const tabId = tabOf(sender)!;
    const open = pending.get(tabId);
    if (open && open.documentId === sender.documentId) {
      open.settle(false);
      await open.allow;
    }
    return { status: "cancelled" };
  }

  function onConfirming(sender: TiktokRouteSender): TiktokRouteReply {
    const open = pending.get(tabOf(sender)!);
    return open && !open.settled && open.invoked && open.documentId === sender.documentId
      ? { status: "confirming" }
      : { status: "idle" };
  }

  async function onOpen(sender: TiktokRouteSender): Promise<TiktokRouteReply> {
    if (!capable(sender)) return { status: "failed" };
    settlePending(tabOf(sender)!);
    const target = await resolveOriginalTarget(sender);
    if (target === null || !(await authority.allow(sender))) return { status: "failed" };
    // The address has done its one job; keep it no longer than needed. The tab's allowance stays.
    await session!.remove(originKey(tabOf(sender)!)).catch(() => {});
    return { status: "open", url: target };
  }

  const forgetTab = (tabId: number) => {
    settlePending(tabId);
    if (session) void session.remove(originKey(tabId)).catch(() => {});
  };
  const onRemoved = (tabId: number) => forgetTab(tabId);
  const onReplaced = (_added: number, removed: number) => forgetTab(removed);
  if (wired) {
    tabs!.onRemoved.addListener(onRemoved);
    tabs!.onReplaced.addListener(onReplaced);
  }

  function handle(kind: string, message: Record<string, unknown>, sender: TiktokRouteSender): Promise<TiktokRouteReply> | null {
    if (kind === TIKTOK_ROUTE.blocked) {
      if (!contentSender(sender)) return null;
      const keys = Object.keys(message);
      const traversal = message.traversal === true;
      if (keys.length > (traversal ? 2 : 1)) return null;
      return onBlocked(sender, traversal);
    }
    if (!screenSender(sender) || Object.keys(message).length !== 1) return null;
    switch (kind) {
      case TIKTOK_ROUTE.screen:
        return onScreen(sender);
      case TIKTOK_ROUTE.request:
        return onRequest(sender);
      case TIKTOK_ROUTE.confirming:
        return Promise.resolve(onConfirming(sender));
      case TIKTOK_ROUTE.confirm:
        return onConfirm(sender);
      case TIKTOK_ROUTE.cancel:
        return onCancel(sender);
      case TIKTOK_ROUTE.open:
        return onOpen(sender);
      default:
        return null;
    }
  }

  const kinds = new Set<string>(Object.values(TIKTOK_ROUTE));
  const failure = (kind: string): TiktokRouteReply =>
    kind === TIKTOK_ROUTE.blocked
      ? { status: "held" }
      : kind === TIKTOK_ROUTE.screen
        ? { status: "unavailable" }
        : kind === TIKTOK_ROUTE.cancel
          ? { status: "cancelled" }
          : kind === TIKTOK_ROUTE.confirming
            ? { status: "idle" }
            : { status: "failed" };

  return {
    authority,
    /** chrome.runtime.onMessage listener: sendResponse + `return true` for its own kinds only. */
    listener(message: unknown, sender: TiktokRouteSender, sendResponse: (reply: TiktokRouteReply) => void): boolean {
      if (stopped || !message || typeof message !== "object" || Array.isArray(message)) return false;
      const kind = (message as { kind?: unknown }).kind;
      if (typeof kind !== "string" || !kinds.has(kind)) return false;
      const work = handle(kind, message as Record<string, unknown>, sender);
      if (!work) return false;
      const budget = kind === TIKTOK_ROUTE.blocked
        ? deps.limits?.contentAnswerMs ?? TIKTOK_CONTENT_ANSWER_MS
        : deps.limits?.pageAnswerMs ?? TIKTOK_PAGE_ANSWER_MS;
      // Each wait is already bounded; the whole answer is too, so a sender always hears back
      // before its own bound and a late success is never reported after a failure.
      void withTimeout(work, budget).then(
        (reply) => sendResponse(stopped ? failure(kind) : reply),
        () => sendResponse(failure(kind)),
      );
      return true;
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const tabId of [...pending.keys()]) settlePending(tabId);
      if (wired) {
        tabs!.onRemoved.removeListener(onRemoved);
        tabs!.onReplaced.removeListener(onReplaced);
      }
      await authority.stop();
    },
  };
}
