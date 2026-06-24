// The MutationObserver that owns lazily-injected / infinitely-scrolled content and same-URL cases
// (e.g. an Instagram Reel opening in a same-URL modal the History hook never sees). Mutations are
// rAF-coalesced so a burst of DOM churn triggers at most one re-apply per frame.

import type { StillWindow } from "./redirect.js";

export interface ObserverHandle {
  start(): void;
  stop(): void;
}

export type Scheduler = (cb: () => void) => void;

function defaultScheduler(win: StillWindow): Scheduler {
  const raf = win.requestAnimationFrame?.bind(win);
  return raf ? (cb) => raf(() => cb()) : (cb) => setTimeout(cb, 0);
}

export function createReapplyObserver(
  win: StillWindow,
  doc: Document,
  reapply: () => void,
  schedule: Scheduler = defaultScheduler(win),
): ObserverHandle {
  let scheduled = false;
  const flush = (): void => {
    scheduled = false;
    reapply();
  };
  const observer = new win.MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    schedule(flush);
  });

  return {
    start() {
      const target = doc.documentElement ?? doc;
      observer.observe(target, { childList: true, subtree: true });
    },
    stop() {
      observer.disconnect();
    },
  };
}
