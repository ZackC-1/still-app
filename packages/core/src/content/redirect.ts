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
  preventDefault?(): void;
}

/**
 * Exactly the window surface the content script depends on. Declared explicitly (rather than the
 * DOM lib `Window`) so it composes with test doubles and the Safari/WKWebView host, and so the
 * `MutationObserver` constructor is part of the contract (the lib `Window` omits it).
 */
export interface StillWindow {
  readonly location: { readonly href: string; replace(url: string): void };
  readonly history: HistoryLike;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  readonly MutationObserver: { new (cb: MutationCallback): MutationObserver };
  requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  readonly navigation?: NavigationLike;
}

/** Where a redirect is performed. Injectable so the engine stays side-effect-free and testable. */
export interface RedirectPort {
  replace(url: string): void;
}

export function locationRedirectPort(win: StillWindow): RedirectPort {
  return { replace: (url) => win.location.replace(url) };
}

/**
 * Hook in-app navigations so the content script re-applies on SPA route changes: History API
 * (`pushState`/`replaceState`), `popstate`, AND the Navigation API `navigate` event (KTD1). The
 * MutationObserver (observer.ts) owns same-URL cases the History hook never sees. Returns teardown.
 */
export function installNavigationHooks(
  win: StillWindow,
  onNavigate: () => void,
  beforeNavigate?: (target: URL) => boolean,
  doc?: Document,
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
  const historyConsumed = (value: string | URL | null | undefined): boolean => {
    const url = targetUrl(value);
    // Preserve native cross-origin history rejection instead of upgrading it to a redirect.
    return (
      !!url &&
      url.origin === new URL(win.location.href).origin &&
      beforeNavigate?.(url) === true
    );
  };

  const wrappedPush: HistoryLike["pushState"] = (data, unused, url) => {
    if (beforeNavigate && historyConsumed(url)) return;
    origPush(data, unused, url);
    onNavigate();
  };
  const wrappedReplace: HistoryLike["replaceState"] = (data, unused, url) => {
    if (beforeNavigate && historyConsumed(url)) return;
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
      beforeNavigate?.(url)
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
    if (url && beforeNavigate(url)) {
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
