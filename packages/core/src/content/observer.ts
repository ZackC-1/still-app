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

const ELEMENT_NODE = 1;

/**
 * True when a batch of mutations introduced at least one element.
 *
 * The observer watches childList on the whole document, and a running feed churns text nodes
 * constantly: view counts, timestamps, live-region announcements. None of those can produce a
 * surface to hide or remove, since every selector matches elements, so a batch that added no
 * element is not worth a sweep. Removals cannot create a match either. On m.youtube.com this drops
 * a large share of frames that previously walked the whole document to find nothing.
 */
function addedAnyElement(records: readonly MutationRecord[]): boolean {
  for (const record of records) {
    const added = record.addedNodes;
    for (let i = 0; i < added.length; i++) {
      if (added[i]!.nodeType === ELEMENT_NODE) return true;
    }
  }
  return false;
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
  const observer = new win.MutationObserver((records) => {
    if (scheduled) return;
    if (!addedAnyElement(records)) return;
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
