/** The teardown-aware subset of WXT's ContentScriptContext used by Safari's nudge loop. */
export interface ContentScriptLifecycle {
  setTimeout(handler: () => void, timeout?: number): number;
  setInterval(handler: () => void, timeout?: number): number;
  addEventListener(target: object, type: string, handler: () => void): void;
  onInvalidated(listener: () => void): () => void;
}

export interface SafariReconcileNudgeDeps {
  readonly lifecycle: ContentScriptLifecycle;
  readonly send: () => Promise<unknown>;
  readonly script: { stop(): void };
  readonly win: object;
  readonly doc: { readonly visibilityState: string };
}

/**
 * Keep the Safari App-Group reconcile nudge active only for its WXT content-script context.
 * WXT owns the timer/listener teardown; invalidation also stops the core content orchestrator.
 */
export function startSafariReconcileNudges(deps: SafariReconcileNudgeDeps): { request(): void } {
  let active = true;
  const request = (): void => {
    if (active) void deps.send().catch(() => {});
  };
  const requestWhenVisible = (): void => {
    if (deps.doc.visibilityState === "visible") request();
  };

  request();
  deps.lifecycle.setTimeout(request, 500);
  deps.lifecycle.addEventListener(deps.win, "focus", request);
  deps.lifecycle.addEventListener(deps.win, "pageshow", request);
  deps.lifecycle.addEventListener(deps.doc, "visibilitychange", requestWhenVisible);
  deps.lifecycle.setInterval(requestWhenVisible, 15_000);
  deps.lifecycle.onInvalidated(() => {
    active = false;
    deps.script.stop();
  });

  return { request };
}
