// The page (main world) half of the sustained-session harness, installed with addInitScript before
// any fixture script runs. It does two jobs:
//
// 1. Simulated site activity: feed growth from clones of the fixture's own feed items, scrolling,
//    SPA route changes (history.pushState plus YouTube's own navigation events) and trimming the
//    feed back to its original size between rounds.
//
// 2. Counting DOM writes the extension makes. A main-world MutationObserver records every
//    mutation. Every main-world entry point that can mutate the page (the harness itself, and the
//    fixture's own observers, timers and listeners) runs inside `asPage`, which first credits any
//    pending records to the extension and then discards the records its own work produced. Page
//    and isolated-world code share one thread, so whatever remains was written by the content
//    script (or, rarely, by the browser itself; there is no parser activity after load).
//
// This function is serialized by Playwright: it must not reference anything outside its body.
export function installMainWorldHarness(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__stillHarness) return;

  type Counts = { attributes: number; childList: number; characterData: number; rootClass: number; nodesAdded: number; nodesRemoved: number };
  const zero = (): Counts => ({ attributes: 0, childList: 0, characterData: 0, rootClass: 0, nodesAdded: 0, nodesRemoved: 0 });
  let writes = zero();
  const credit = (records: MutationRecord[]) => {
    for (const r of records) {
      writes[r.type]++;
      if (r.type === "attributes" && r.target === document.documentElement) writes.rootClass++;
      writes.nodesAdded += r.addedNodes.length;
      writes.nodesRemoved += r.removedNodes.length;
    }
  };
  const NativeMutationObserver = window.MutationObserver;
  const recorder = new NativeMutationObserver((records) => credit(records));
  recorder.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  let depth = 0;
  function asPage<T>(fn: () => T): T {
    if (depth++ === 0) credit(recorder.takeRecords());
    try {
      return fn();
    } finally {
      if (--depth === 0) recorder.takeRecords();
    }
  }
  const wrap = <F extends (...args: never[]) => unknown>(fn: F): F =>
    function (this: unknown, ...args: never[]) {
      return asPage(() => fn.apply(this, args));
    } as F;

  // Page-world async entry points (the fixtures use an IntersectionObserver; the rest is cover).
  for (const name of ["IntersectionObserver", "MutationObserver", "ResizeObserver"] as const) {
    const Native = window[name] as unknown as new (cb: (...a: never[]) => unknown, o?: unknown) => object;
    if (!Native) continue;
    const Wrapped = function (callback: (...a: never[]) => unknown, options?: unknown) {
      return new Native(wrap(callback), options);
    } as unknown as typeof Native;
    Wrapped.prototype = Native.prototype;
    (window as unknown as Record<string, unknown>)[name] = Wrapped;
  }
  const timers = window as unknown as Record<string, (cb: unknown, ...rest: unknown[]) => unknown>;
  for (const name of ["setTimeout", "setInterval", "requestAnimationFrame", "queueMicrotask"]) {
    const native = timers[name]!.bind(window);
    timers[name] = (cb: unknown, ...rest: unknown[]) =>
      native(typeof cb === "function" ? wrap(cb as (...a: never[]) => unknown) : cb, ...rest);
  }
  const listenerWrappers = new WeakMap<object, EventListener>();
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (typeof listener !== "function") return nativeAdd.call(this, type, listener, options);
    let wrapped = listenerWrappers.get(listener);
    if (!wrapped) listenerWrappers.set(listener, (wrapped = wrap(listener as (...a: never[]) => unknown) as EventListener));
    return nativeAdd.call(this, type, wrapped, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const wrapped = typeof listener === "function" ? listenerWrappers.get(listener) : undefined;
    return nativeRemove.call(this, type, wrapped ?? listener, options);
  };

  // The feed: the element with the most element children, chosen once, cloned from its originals.
  let feed: Element | null = null;
  let pool: Element[] = [];
  let next = 0;
  const pickFeed = () => {
    if (feed?.isConnected) return feed;
    let best: Element = document.body;
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (el.childElementCount > best.childElementCount && !el.closest("[data-still-harness-clone]")) best = el;
    }
    feed = best;
    pool = Array.from(best.children).filter((c) => !c.hasAttribute("data-still-harness-clone")).map((c) => {
      const copy = c.cloneNode(true) as Element;
      for (const node of [copy, ...Array.from(copy.querySelectorAll("[id]"))]) node.removeAttribute("id");
      copy.setAttribute("data-still-harness-clone", "");
      return copy;
    });
    return best;
  };
  const nodeCount = () => document.getElementsByTagName("*").length;

  w.__stillHarness = {
    /** Append feed items until the document holds at least `target` elements. */
    growTo(target: number) {
      return asPage(() => {
        const container = pickFeed();
        if (!pool.length) return nodeCount();
        let guard = 0;
        while (nodeCount() < target && guard++ < 100_000) container.appendChild(pool[next++ % pool.length]!.cloneNode(true));
        return nodeCount();
      });
    },
    grow(by: number) {
      return (w.__stillHarness as { growTo(n: number): number }).growTo(nodeCount() + by);
    },
    trim() {
      return asPage(() => {
        for (const el of Array.from(document.querySelectorAll("[data-still-harness-clone]"))) el.remove();
        return nodeCount();
      });
    },
    scroll(dy: number) {
      asPage(() => window.scrollBy(0, dy));
    },
    /** A same-document route change the way the sites make one, then a swap of the feed contents. */
    navigate(path: string) {
      asPage(() => {
        document.dispatchEvent(new CustomEvent("yt-navigate-start"));
        history.pushState({ still: path }, "", path);
        document.dispatchEvent(new CustomEvent("yt-navigate-finish"));
        document.dispatchEvent(new CustomEvent("yt-page-data-updated"));
      });
    },
    back() {
      asPage(() => history.back());
    },
    nodeCount,
    /** DOM writes credited to the extension since the last call. */
    takeWrites() {
      credit(recorder.takeRecords());
      const out = writes;
      writes = zero();
      return out;
    },
  };
}

export interface MainWorldHarness {
  growTo(target: number): number;
  grow(by: number): number;
  trim(): number;
  scroll(dy: number): void;
  navigate(path: string): void;
  back(): void;
  nodeCount(): number;
  takeWrites(): DomWrites;
}

export interface DomWrites {
  attributes: number;
  childList: number;
  characterData: number;
  rootClass: number;
  nodesAdded: number;
  nodesRemoved: number;
}
