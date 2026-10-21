/** Presentation navigation only. No account, purchase, settings or browsing data is stored. */
export const PRO_NAVIGATION_KEY = "still:pro-navigation";
export const PRO_OPTIONS_HASH = "#still-pro";
const REQUEST_LIFETIME_MS = 30_000;

type Request = { target: "pro"; token: string; expiresAt: number };

function readRequest(value: unknown): Request | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  const now = Date.now();
  return Object.keys(request).length === 3 &&
    request.target === "pro" &&
    typeof request.token === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.token) &&
    typeof request.expiresAt === "number" &&
    Number.isSafeInteger(request.expiresAt) &&
    request.expiresAt > now &&
    request.expiresAt <= now + REQUEST_LIFETIME_MS
    ? (request as Request)
    : null;
}

/** The last answer this browser session, so the card can show at once on the next opening (it is
 * still re-asked every time). Session storage only: gone when the browser closes. */
export const PRO_OFFER_READY_KEY = "still:pro-offer-ready";

/**
 * "Would the Settings page offer Get Still Pro right now?" (ISS-0032). The popup's Still Pro card
 * shows only on a yes, so it never leads to a card that says Still Pro can't be bought here. The
 * same question the Settings card asks (lib/browser-pro.ts askCheckoutAvailable, answered by
 * lib/checkout-availability.ts in paid-tier builds); spelled here so the popup takes no value from
 * the Settings card's module. `true` and `false` are the background's answers (anything malformed
 * is "no"); `undefined` is no answer at all (no receiver yet, a failure or the deadline), which the
 * popup treats as "ask again", never as "no". Display only: checkout runs its own fresh check
 * before anything opens.
 */
export async function askProOfferReady(timeoutMs = PRO_OFFER_ASK_TIMEOUT_MS): Promise<boolean | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unanswered = Symbol("unanswered");
  try {
    const reply: unknown = await Promise.race([
      chrome.runtime.sendMessage({ kind: "still:session", action: "checkoutAvailable" }),
      // A background that never replies (still waking, or a sales check that hangs) is "no answer
      // yet", so the popup can ask again instead of waiting for this opening to end.
      new Promise((resolve) => { timer = setTimeout(() => resolve(unanswered), timeoutMs); }),
    ]);
    return reply === unanswered || reply === undefined ? undefined : reply === true;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** How long one "would Settings offer Get Still Pro?" question may wait for the background. */
export const PRO_OFFER_ASK_TIMEOUT_MS = 3_000;
/** The popup's bounded re-asks after a "no" before its first "yes" (ISS-0032): about 7.5 s. */
export const PRO_OFFER_RETRY_MS: readonly number[] = [500, 1_000, 2_000, 4_000];

/** Remember only an answer the live popup accepted after checking its request lifetime. */
export async function rememberProOfferReady(ready: boolean): Promise<void> {
  try {
    await chrome.storage?.session?.set({ [PRO_OFFER_READY_KEY]: ready });
  } catch {
    // The remembered answer only avoids a late card on the next opening.
  }
}

export async function lastProOfferReady(): Promise<boolean> {
  try {
    return (await chrome.storage?.session?.get(PRO_OFFER_READY_KEY))?.[PRO_OFFER_READY_KEY] === true;
  } catch {
    return false;
  }
}

export function canNavigateToPro(): boolean {
  return Boolean(chrome.storage?.session && chrome.runtime?.openOptionsPage);
}

/** The browser focuses/reuses its own options page; no tab permission or tab URL read is needed. */
export async function openBrowserPro(): Promise<void> {
  if (!canNavigateToPro()) return;
  try {
    await chrome.storage.session.set({
      [PRO_NAVIGATION_KEY]: {
        target: "pro",
        token: crypto.randomUUID(),
        expiresAt: Date.now() + REQUEST_LIFETIME_MS,
      } satisfies Request,
    });
    await chrome.runtime.openOptionsPage();
  } catch {
    // A missing browser destination never starts checkout or changes saved choices.
  }
}

/** Consume navigation once, including a request made before this lazy options host existed. */
export function bindProOptionsNavigation(root: HTMLElement): () => void {
  let stopped = false;
  let readRevision = 0;
  let lastToken: string | null = null;
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resize: ResizeObserver | null = null;
  let focusedCard: HTMLElement | null = null;
  let focusDeadline = 0;
  function stopWatching() {
    focusDeadline = 0;
    observer?.disconnect();
    observer = null;
    resize?.disconnect();
    resize = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  /** Firefox's runtime.openOptionsPage reuses an open Settings tab only when its address matches
   * exactly, hash included (ISS-0097), so the hand-off hash must not outlive the hand-off: it goes
   * once the card has been reached, and when the focus window ends. */
  function clearHash() {
    if (window.location.hash === PRO_OPTIONS_HASH)
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  function cancelFocus() {
    stopWatching();
    clearHash();
  }
  function reveal() {
    if (Date.now() >= focusDeadline) {
      cancelFocus();
      return false;
    }
    if (stopped || !root.isConnected) return false;
    if (root.querySelector('[role="dialog"][aria-modal="true"]')) return false;
    const card = root.querySelector<HTMLElement>('section[aria-label="Still Pro"]');
    if (!card) return false;
    card.setAttribute("tabindex", "-1");
    card.scrollIntoView?.({ block: "start" });
    if (focusedCard !== card) {
      card.focus({ preventScroll: true });
      focusedCard = card;
    }
    // Reached: the address is plain again while the deadline keeps following late content.
    clearHash();
    return true;
  }
  function requestFocus(expiresAt = Date.now() + REQUEST_LIFETIME_MS) {
    stopWatching();
    focusDeadline = expiresAt;
    focusedCard = null;
    reveal();
    observer = new MutationObserver(reveal);
    observer.observe(root, { childList: true, subtree: true });
    if (typeof ResizeObserver !== "undefined") {
      resize = new ResizeObserver(reveal);
      resize.observe(root);
    }
    timer = setTimeout(cancelFocus, Math.max(0, expiresAt - Date.now()));
  }
  function accept(value: unknown) {
    const request = readRequest(value);
    if (stopped || !request || request.token === lastToken) return;
    lastToken = request.token;
    window.history.replaceState(null, "", PRO_OPTIONS_HASH);
    requestFocus(request.expiresAt);
  }
  function changed(changes: Record<string, chrome.storage.StorageChange>, area: string) {
    if (area !== "session" || !(PRO_NAVIGATION_KEY in changes)) return;
    readRevision += 1;
    accept(changes[PRO_NAVIGATION_KEY]?.newValue);
  }
  function hashChanged() {
    readRevision += 1;
    if (window.location.hash === PRO_OPTIONS_HASH) requestFocus();
    else cancelFocus();
  }
  window.addEventListener("hashchange", hashChanged);
  root.addEventListener("pointerdown", cancelFocus);
  root.addEventListener("keydown", cancelFocus);
  window.addEventListener("wheel", cancelFocus, { passive: true });
  window.addEventListener("touchstart", cancelFocus, { passive: true });
  chrome.storage.onChanged.addListener(changed);
  if (window.location.hash === PRO_OPTIONS_HASH) requestFocus();
  const revision = readRevision;
  void chrome.storage.session?.get(PRO_NAVIGATION_KEY).then((record) => {
    if (!stopped && revision === readRevision) accept(record[PRO_NAVIGATION_KEY]);
  }).catch(() => {});
  return () => {
    stopped = true;
    readRevision += 1;
    cancelFocus();
    window.removeEventListener("hashchange", hashChanged);
    root.removeEventListener("pointerdown", cancelFocus);
    root.removeEventListener("keydown", cancelFocus);
    window.removeEventListener("wheel", cancelFocus);
    window.removeEventListener("touchstart", cancelFocus);
    chrome.storage.onChanged.removeListener(changed);
  };
}
