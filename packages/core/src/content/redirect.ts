// SPA navigation hooks + the redirect port. The Shorts→watch redirect on Chromium is the static
// DNR rule (U10, network-layer, zero paint); this content-script path is the Safari redirect (KTD1)
// and the in-app SPA hook for both engines.

/** History-like surface we monkey-patch (minimal so test doubles don't need a full History). */
export interface HistoryLike {
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/** The Navigation API subset we use, declared locally to avoid lib/version coupling. */
export interface NavigationLike {
  addEventListener(
    type: "navigate" | "navigatesuccess",
    cb: (event?: NavigationEventLike) => void,
  ): void;
  removeEventListener(
    type: "navigate" | "navigatesuccess",
    cb: (event?: NavigationEventLike) => void,
  ): void;
}

export interface NavigationEventLike {
  readonly destination?: { readonly url: string };
  readonly cancelable?: boolean;
  readonly defaultPrevented?: boolean;
  readonly isTrusted?: boolean;
  readonly navigationType?: "push" | "replace" | "reload" | "traverse";
  /** True when the person activated a link (or similar), false when page script navigated. */
  readonly userInitiated?: boolean;
  preventDefault?(): void;
}

/**
 * Who asked for a prospective navigation. "deliberate": the person activated a link (trusted
 * click/Enter, or a Navigation API event marked userInitiated), or moved through history.
 * "page": page script changed the URL on its own, e.g. a viewer advancing to its next item.
 */
export type NavigationIntent = "deliberate" | "page";

/** A deliberate link activation still counts for the page's own pushState within this window. */
const DELIBERATE_WINDOW_MS = 2_500;

/**
 * Remembers the last link the person deliberately activated (trusted click or Enter on an
 * anchor). Single-page sites intercept the click and push the URL themselves, so a push to that
 * exact route soon afterwards carries the person's intent, not the page's. Generic button clicks
 * and keys are never recorded: only an exact link route counts.
 */
export interface NavigationIntentTracker {
  recordLink(url: URL): void;
  intentFor(url: URL): NavigationIntent;
}

export function createNavigationIntentTracker(now: () => number = Date.now): NavigationIntentTracker {
  let deliberate: { readonly key: string; readonly at: number } | null = null;
  // YouTube's /watch is one route for every video, so its key also names the video and the
  // playlist: a page-driven move to ANOTHER video or into a list it added (an automatic Mix)
  // within the deliberate window is never the person's link. Other routes keep the path rule.
  const routeKey = (url: URL) => {
    const route = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    const youtube = url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com");
    return youtube && url.pathname === "/watch"
      ? `${route}?v=${url.searchParams.get("v") ?? ""}&list=${url.searchParams.get("list") ?? ""}` : route;
  };
  return {
    recordLink: (url) => { deliberate = { key: routeKey(url), at: now() }; },
    intentFor: (url) =>
      deliberate && deliberate.key === routeKey(url) && now() - deliberate.at <= DELIBERATE_WINDOW_MS
        ? "deliberate" : "page",
  };
}

/**
 * Exactly the window surface the content script depends on. Declared explicitly (rather than the
 * DOM lib `Window`) so it composes with test doubles and the Safari/WKWebView host, and so the
 * `MutationObserver` constructor is part of the contract (the lib `Window` omits it).
 */
export interface StillWindow {
  readonly location: {
    readonly href: string;
    replace(url: string): void;
    assign?(url: string): void;
  };
  readonly history: HistoryLike;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  readonly MutationObserver: { new (cb: MutationCallback): MutationObserver };
  requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  readonly navigation?: NavigationLike;
}

/** Where a redirect is performed. Injectable so the engine stays side-effect-free and testable. */
export interface RedirectPort {
  /** Omitted mode retains legacy replacement; consumed pushes preserve the origin entry. */
  replace(url: string, mode?: "push"): void;
}

export function locationRedirectPort(win: StillWindow): RedirectPort {
  return {
    replace: (url, mode) => {
      if (mode === "push") {
        if (!win.location.assign)
          throw new TypeError("Push navigation requires location.assign");
        win.location.assign(url);
      } else win.location.replace(url);
    },
  };
}

/**
 * Hook in-app navigations so the content script re-applies on SPA route changes: History API
 * (`pushState`/`replaceState`), `popstate`, AND the Navigation API `navigate` event (KTD1). The
 * MutationObserver (observer.ts) owns same-URL cases the History hook never sees. Returns teardown.
 */
export function installNavigationHooks(
  win: StillWindow,
  onNavigate: () => void,
  beforeNavigate?: (target: URL, mode: "push" | "replace", intent: NavigationIntent) => boolean,
  doc?: Document,
  intents: NavigationIntentTracker = createNavigationIntentTracker(),
): () => void {
  const history = win.history;
  const push = history.pushState;
  const replace = history.replaceState;
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);

  const targetUrl = (value: string | URL | null | undefined): URL | null => {
    if (value == null) return null;
    try {
      const url = new URL(String(value), win.location.href);
      return ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
        ? url
        : null;
    } catch {
      return null;
    }
  };
  const intentFor = (url: URL): NavigationIntent => intents.intentFor(url);
  const historyConsumed = (
    value: string | URL | null | undefined,
    mode: "push" | "replace",
  ): boolean => {
    const url = targetUrl(value);
    // Preserve native cross-origin history rejection instead of upgrading it to a redirect.
    return (
      !!url &&
      url.origin === new URL(win.location.href).origin &&
      beforeNavigate?.(url, mode, intentFor(url)) === true
    );
  };

  const wrappedPush: HistoryLike["pushState"] = (data, unused, url) => {
    if (beforeNavigate && historyConsumed(url, "push")) return;
    origPush(data, unused, url);
    onNavigate();
  };
  const wrappedReplace: HistoryLike["replaceState"] = (data, unused, url) => {
    if (beforeNavigate && historyConsumed(url, "replace")) return;
    origReplace(data, unused, url);
    onNavigate();
  };
  history.pushState = wrappedPush;
  history.replaceState = wrappedReplace;

  const onPop = (): void => onNavigate();
  win.addEventListener("popstate", onPop);

  const nav = win.navigation;
  const onNav = (event?: NavigationEventLike): void => {
    const url = targetUrl(event?.destination?.url);
    if (
      url &&
      event?.isTrusted === true &&
      !event?.defaultPrevented &&
      event?.cancelable === true &&
      event.preventDefault &&
      beforeNavigate?.(
        url,
        !event.navigationType || event.navigationType === "push"
          ? "push"
          : "replace",
        event.userInitiated === true ||
          event.navigationType === "traverse" ||
          event.navigationType === "reload"
          ? "deliberate"
          : intentFor(url),
      )
    ) {
      event.preventDefault();
      return;
    }
    // `navigate` precedes the URL commit. Reapplying the old URL here can recursively issue
    // location.replace while its own new navigation is being dispatched. The modern lane
    // reapplies on actual success; legacy callers retain their existing callback timing.
    if (!beforeNavigate) onNavigate();
  };
  nav?.addEventListener("navigate", onNav);
  const onSuccess = (): void => onNavigate();
  if (beforeNavigate) nav?.addEventListener("navigatesuccess", onSuccess);

  const onLink = (event: MouseEvent | KeyboardEvent): void => {
    if (
      !beforeNavigate ||
      !event.isTrusted ||
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    if (
      event instanceof MouseEvent
        ? event.button !== 0
        : event.key !== "Enter" || event.repeat
    )
      return;
    const target = event
      .composedPath()
      .find((node) => node instanceof Element) as Element | undefined;
    const anchor = target?.closest<HTMLAnchorElement>("a[href]");
    if (
      !anchor ||
      anchor.hasAttribute("download") ||
      (anchor.target && anchor.target !== "_self")
    )
      return;
    const url = targetUrl(anchor.href);
    if (url) intents.recordLink(url);
    if (url && beforeNavigate(url, "push", "deliberate")) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  if (beforeNavigate && doc) {
    doc.addEventListener("click", onLink, true);
    doc.addEventListener("keydown", onLink, true);
  }

  return () => {
    // Restore exact method identity, and never overwrite a later host/extension wrapper.
    if (history.pushState === wrappedPush) history.pushState = push;
    if (history.replaceState === wrappedReplace) history.replaceState = replace;
    win.removeEventListener("popstate", onPop);
    nav?.removeEventListener("navigate", onNav);
    if (beforeNavigate) nav?.removeEventListener("navigatesuccess", onSuccess);
    doc?.removeEventListener("click", onLink, true);
    doc?.removeEventListener("keydown", onLink, true);
  };
}

/**
 * URL-change fallback for browsers without the Navigation API (Safari before 26.2, Firefox ESR).
 * A content script's history wrapper lives in its isolated world and never sees the page's own
 * pushState, so without `window.navigation` page-driven moves are invisible. This polls
 * location.href on a short interval (no MutationObserver, no main-world script) and reports
 * each change once, with the previous URL. popstate/hashchange report at once; popstate is
 * history traversal (deliberate). The poll runs only while `active` and the document is
 * visible; the history listeners stay attached while `active`, hidden or not.
 */
export interface UrlChangeWatch {
  /** Re-evaluate whether to run; call after anything that may change `active`. */
  sync(active: boolean): void;
  /** Reads the address now (as a poll tick would), while the watch is wanted. */
  check(): void;
  stop(): void;
  /** Test/diagnostic: whether the interval is currently scheduled. */
  running(): boolean;
}

export const URL_WATCH_INTERVAL_MS = 250;

export function createUrlChangeWatch(input: {
  readonly win: StillWindow;
  readonly doc: Document;
  readonly onChange: (from: URL, to: URL, traverse: boolean) => void;
  readonly intervalMs?: number;
}): UrlChangeWatch {
  const { win, doc, onChange } = input;
  let last = win.location.href;
  let wanted = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const report = (traverse: boolean) => {
    const href = win.location.href;
    if (href === last) return;
    const from = last;
    last = href;
    let previous: URL, next: URL;
    try {
      previous = new URL(from);
      next = new URL(href);
    } catch {
      return;
    }
    onChange(previous, next, traverse);
  };
  const poll = () => report(false);
  // History listeners stay attached whenever the watch is wanted, visible or not: a Back or
  // forward taken while the tab is hidden still moves the baseline, so resuming the poll never
  // mistakes that traversal for the page advancing on its own.
  let listening = false;
  const onPop = () => { if (listening) report(true); };
  const onHash = () => { if (listening) report(false); };
  const apply = () => {
    const listen = wanted && !stopped;
    if (listen && !listening) {
      win.addEventListener("popstate", onPop);
      win.addEventListener("hashchange", onHash);
      listening = true;
    } else if (!listen && listening) {
      win.removeEventListener("popstate", onPop);
      win.removeEventListener("hashchange", onHash);
      listening = false;
    }
    const run = listen && doc.visibilityState !== "hidden";
    if (run && timer === null) {
      timer = setInterval(poll, input.intervalMs ?? URL_WATCH_INTERVAL_MS);
    } else if (!run && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const onVisibility = () => apply();
  doc.addEventListener("visibilitychange", onVisibility);
  return {
    sync(active) {
      if (stopped) return;
      // Starting fresh baselines on the URL the caller has just handled.
      if (active && !wanted) last = win.location.href;
      wanted = active;
      apply();
    },
    stop() {
      stopped = true;
      wanted = false;
      apply();
      doc.removeEventListener("visibilitychange", onVisibility);
    },
    check() {
      if (listening) report(false);
    },
    running: () => timer !== null,
  };
}
