// Which kind of Firefox this copy of Still is running in, from the browser's own answer.
//
// The Firefox build is one package for desktop Firefox and Firefox for Android. Only the browser can
// say which it is: `runtime.getPlatformInfo().os` is "android" in Firefox for Android and a desktop
// OS everywhere else. Nothing here ever looks at the window size, the screen, or the user agent: a
// narrow desktop window is still desktop Firefox, and must never get the phone popup or be counted
// as Android.
//
// The Chromium build never asks. Chrome's own answer cannot change anything there, so it keeps
// exactly the presentation and analytics surface it has always had.

export type RuntimePlatform = "android" | "desktop";

/** The one browser call this module needs (WebExtensions `runtime.getPlatformInfo`). */
export interface PlatformInfoSource {
  getPlatformInfo?: () => Promise<{ os: string }>;
}

/** How long a page waits for the browser's answer before carrying on as desktop. The answer is a
 * local call and normally arrives at once; this only keeps a page from waiting forever on it.
 *
 * Fallback, on purpose: if Firefox for Android ever took longer than this (or failed), that copy
 * would behave as desktop Firefox for that page or background start. That means the desktop popup
 * (which still fits a phone through its width clamp), the pin step shown, the "firefox" analytics
 * surface, and the TikTok one-tab allowance not held closed. Nothing is ever guessed from the
 * screen instead. Every caller asks again on its next start. */
export const PLATFORM_ANSWER_LIMIT_MS = 1_000;

/** "android" only when the browser itself says so. A missing API, a failure, no answer in time or
 * any other answer is "desktop", which is exactly what every Still build reported before Firefox
 * for Android. Never rejects. */
export async function detectRuntimePlatform(
  runtime: PlatformInfoSource | undefined,
  limitMs: number = PLATFORM_ANSWER_LIMIT_MS,
): Promise<RuntimePlatform> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = runtime?.getPlatformInfo?.();
    if (!answer) return "desktop";
    const info = await Promise.race([
      answer,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), limitMs);
      }),
    ]);
    return info?.os === "android" ? "android" : "desktop";
  } catch {
    return "desktop";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Firefox for Android: the Firefox build, on a platform the browser reports as Android. */
export function isFirefoxAndroid(
  isFirefox: boolean,
  platform: RuntimePlatform,
): boolean {
  return isFirefox && platform === "android";
}

/** The platform for this build. Chromium resolves to desktop without asking the browser. */
export function runtimePlatformFor(
  isFirefox: boolean,
  runtime: PlatformInfoSource | undefined,
): Promise<RuntimePlatform> {
  return isFirefox
    ? detectRuntimePlatform(runtime)
    : Promise.resolve("desktop");
}

/** The popup presentation loader for this build: the phone popup only in Firefox for Android, the
 * desktop popup everywhere else. The platform is awaited inside the loader, so the popup never
 * shows one presentation and then swaps to the other. */
export function popupPresentationLoader<T>(
  isFirefox: boolean,
  platform: Promise<RuntimePlatform>,
  loaders: {
    readonly desktop: () => Promise<T>;
    readonly firefoxAndroid: () => Promise<T>;
  },
): () => Promise<T> {
  return async () =>
    isFirefoxAndroid(isFirefox, await platform)
      ? loaders.firefoxAndroid()
      : loaders.desktop();
}

/** Whether this platform may offer the one-tab TikTok allowance. Owner ruling: Firefox for Android
 * reports it unavailable (no re-implementation there). Closed until the browser has answered, so
 * nothing is offered on a platform that turns out to be Android; Chromium is open and known at
 * once. `ready` settles when the answer is in (bounded by PLATFORM_ANSWER_LIMIT_MS upstream). */
export interface PlatformGate {
  readonly open: boolean;
  readonly known: boolean;
  readonly ready: Promise<void>;
}

export function tabAllowancePlatformGate(
  isFirefox: boolean,
  platform: Promise<RuntimePlatform>,
): PlatformGate {
  let open = !isFirefox;
  let known = !isFirefox;
  const ready = isFirefox
    ? platform.then(
        (answer) => {
          open = !isFirefoxAndroid(isFirefox, answer);
          known = true;
        },
        () => {
          open = true; // detectRuntimePlatform never rejects; a rejection here means desktop.
          known = true;
        },
      )
    : Promise.resolve();
  return {
    get open() {
      return open;
    },
    get known() {
      return known;
    },
    ready,
  };
}

/** The TikTok route's "can this browser re-prove the blocked page document" capability: only where
 * the browser can (runtime.getContexts) AND the platform gate is open (never Firefox for Android). */
export function gatedDocumentVerification(
  browserCanVerify: boolean,
  gate: PlatformGate,
): boolean {
  return browserCanVerify && gate.open;
}

type MessageListener<S, R> = (
  message: unknown,
  sender: S,
  sendResponse: (reply: R) => void,
) => boolean;

/**
 * Hold the route's own messages until the platform answer is in, then hand them over. Without this,
 * a desktop Firefox page that asked during the (at most one second) pending window would be told
 * "unavailable" for good. Other messages pass straight through. A held message the route then
 * declines gets no answer, exactly as if the route had declined it at once.
 */
export function afterPlatformAnswer<S, R>(
  listener: MessageListener<S, R>,
  gate: PlatformGate,
  handles: (message: unknown) => boolean,
): MessageListener<S, R> {
  return (message, sender, sendResponse) => {
    if (gate.known || !handles(message)) return listener(message, sender, sendResponse);
    void gate.ready.then(() => {
      listener(message, sender, sendResponse);
    });
    return true;
  };
}
