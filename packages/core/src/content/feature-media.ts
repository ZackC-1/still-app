/** Quiet only media owned by the caller's current compiled hide plan. No renderer mutation,
 * observer, player preference write, global method patch or autoplay restoration. */
export function createFeatureMediaQuieting(input: {
  readonly doc: Document;
  readonly activeKey: () => string;
  readonly isHidden: (media: HTMLMediaElement) => boolean;
}) {
  const { doc, activeKey, isHidden } = input;
  const active = new Set<HTMLMediaElement>();
  const MAX_ACTIVE = 32,
    MAX_SETUP = 64,
    MAX_FLUSH = 8,
    BUDGET_MS = 2,
    INTERVAL_MS = 25;
  let key = "",
    stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushChecked = 0,
    setupVisited = 0;
  const now = () => doc.defaultView?.performance.now() ?? performance.now();
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    active.clear();
  };
  const playing = (media: HTMLMediaElement) =>
    media.isConnected && !media.paused && !media.ended;
  const quiet = (media: HTMLMediaElement): boolean => {
    if (stopped || !activeKey() || !playing(media) || !isHidden(media))
      return false;
    // Revalidate immediately before the sole irreversible action. A player preference,
    // volume, mute, currentTime, listener and future playback intention stay site-owned.
    if (!playing(media) || !isHidden(media)) return false;
    try {
      media.pause();
    } catch {
      /* a disposed/native player cannot break other players */
    }
    return media.paused;
  };
  const observe = (media: HTMLMediaElement) => {
    if (quiet(media) || !playing(media)) active.delete(media);
    else if (active.size < MAX_ACTIVE || active.has(media)) active.add(media);
  };
  const schedule = () => {
    if (!stopped && timer === null && active.size && activeKey())
      timer = setTimeout(flush, INTERVAL_MS);
  };
  const flush = () => {
    timer = null;
    lastFlushChecked = 0;
    if (stopped || !activeKey()) {
      clear();
      return;
    }
    const started = now();
    // Rotate at most eight retained players. No document query or new-node retention per tick.
    for (const media of [...active]) {
      if (lastFlushChecked >= MAX_FLUSH || now() - started >= BUDGET_MS) break;
      lastFlushChecked++;
      active.delete(media);
      observe(media);
    }
    schedule();
  };
  const onMedia = (event: Event) => {
    const Media = doc.defaultView?.HTMLMediaElement;
    if (stopped || !activeKey() || !Media || !(event.target instanceof Media))
      return;
    observe(event.target);
    schedule();
  };
  const events = [
    "play",
    "playing",
    "timeupdate",
    "pause",
    "ended",
    "emptied",
  ] as const;
  let listening = false;
  const detach = () => {
    if (!listening) return;
    for (const event of events) doc.removeEventListener(event, onMedia, true);
    listening = false;
  };
  return {
    reconcile() {
      if (stopped) return;
      const next = activeKey();
      if (next === key) return;
      key = next;
      clear();
      detach();
      setupVisited = 0;
      if (!key) return;
      for (const event of events) doc.addEventListener(event, onMedia, true);
      listening = true;
      const started = now();
      // Live media-only collections avoid materializing a body-wide node snapshot. Setup is
      // bounded; later native media events handle new players and overflow without a sweep.
      for (const tag of ["video", "audio"] as const) {
        const media = doc.getElementsByTagName(tag);
        for (
          let i = 0;
          i < media.length &&
          setupVisited < MAX_SETUP &&
          now() - started < BUDGET_MS;
          i++
        ) {
          setupVisited++;
          observe(media[i]!);
        }
      }
      schedule();
    },
    debugStats: () => ({
      retainedPlayers: active.size,
      timerPending: timer !== null,
      lastFlushChecked,
      setupVisited,
    }),
    stop() {
      stopped = true;
      key = "";
      clear();
      detach();
    },
  };
}
