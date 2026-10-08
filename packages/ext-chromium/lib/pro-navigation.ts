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
  let focusDeadline = 0;
  function cancelFocus() {
    observer?.disconnect();
    observer = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function reveal() {
    if (Date.now() >= focusDeadline) {
      cancelFocus();
      return false;
    }
    if (stopped || !root.isConnected || window.location.hash !== PRO_OPTIONS_HASH)
      return false;
    if (root.querySelector('[role="dialog"][aria-modal="true"]')) return false;
    const card = root.querySelector<HTMLElement>('section[aria-label="Still Pro"]');
    if (!card) return false;
    cancelFocus();
    card.setAttribute("tabindex", "-1");
    card.scrollIntoView?.({ block: "center" });
    if (document.activeElement !== card) card.focus({ preventScroll: true });
    return true;
  }
  function requestFocus(expiresAt = Date.now() + REQUEST_LIFETIME_MS) {
    cancelFocus();
    focusDeadline = expiresAt;
    if (reveal()) return;
    observer = new MutationObserver(reveal);
    observer.observe(root, { childList: true, subtree: true });
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
    chrome.storage.onChanged.removeListener(changed);
  };
}
