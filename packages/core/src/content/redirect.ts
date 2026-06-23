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
  addEventListener(type: "navigate", cb: () => void): void;
  removeEventListener(type: "navigate", cb: () => void): void;
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
export function installNavigationHooks(win: StillWindow, onNavigate: () => void): () => void {
  const history = win.history;
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);

  history.pushState = (data, unused, url) => {
    origPush(data, unused, url);
    onNavigate();
  };
  history.replaceState = (data, unused, url) => {
    origReplace(data, unused, url);
    onNavigate();
  };

  const onPop = (): void => onNavigate();
  win.addEventListener("popstate", onPop);

  const nav = win.navigation;
  const onNav = (): void => onNavigate();
  nav?.addEventListener("navigate", onNav);

  return () => {
    history.pushState = origPush;
    history.replaceState = origReplace;
    win.removeEventListener("popstate", onPop);
    nav?.removeEventListener("navigate", onNav);
  };
}
