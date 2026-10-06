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

/** "unknown" when the browser gave no usable answer in time (or failed). Presentation and analytics
 * treat it as desktop; the TikTok one-tab allowance treats it as closed. */
export type RuntimePlatform = "android" | "desktop" | "unknown";

/** The one browser call this module needs (WebExtensions `runtime.getPlatformInfo`). */
export interface PlatformInfoSource {
  getPlatformInfo?: () => Promise<{ os: string }>;
}

/** How long a page waits for the browser's answer before carrying on without it. The answer is a
 * local call and normally arrives at once; this only keeps a page from waiting forever on it.
 *
 * Without an answer in time (or on a failure) the platform is "unknown". The popup, first-run page
 * and analytics then behave as desktop Firefox for that page or background start: the desktop popup
 * (which still fits a phone through its width clamp), the pin step shown, the "firefox" analytics
 * surface. The TikTok one-tab allowance does the opposite and stays closed, because the owner ruled
 * that Firefox for Android never offers it; it opens only on an explicit desktop answer, including
 * one that arrives after this limit (see tabAllowancePlatformGate). Nothing is ever guessed from
 * the screen instead. Every caller asks again on its next start. */
export const PLATFORM_ANSWER_LIMIT_MS = 1_000;

/** The browser's answer twice over: `bounded` settles within the limit ("unknown" if the answer is
 * late), `eventual` is the answer itself whenever it comes (it may never settle). Neither rejects. */
export interface PlatformAnswer {
  readonly bounded: Promise<RuntimePlatform>;
  readonly eventual: Promise<RuntimePlatform>;
}

const KNOWN_DESKTOP: PlatformAnswer = {
  bounded: Promise.resolve("desktop"),
  eventual: Promise.resolve("desktop"),
};

/** Ask the browser once. "android" only when it says so; any other OS is "desktop"; a missing API or
 * a failure is "unknown". */
export function askRuntimePlatform(
  runtime: PlatformInfoSource | undefined,
  limitMs: number = PLATFORM_ANSWER_LIMIT_MS,
): PlatformAnswer {
  let eventual: Promise<RuntimePlatform>;
  try {
    const answer = runtime?.getPlatformInfo?.();
    eventual = answer
      ? Promise.resolve(answer).then(
          (info): RuntimePlatform => (info?.os === "android" ? "android" : "desktop"),
          (): RuntimePlatform => "unknown",
        )
      : Promise.resolve("unknown");
  } catch {
    eventual = Promise.resolve("unknown");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = Promise.race([
    eventual,
    new Promise<RuntimePlatform>((resolve) => {
      timer = setTimeout(() => resolve("unknown"), limitMs);
    }),
  ]).finally(() => clearTimeout(timer));
  return { bounded, eventual };
}

/** The bounded answer alone (see askRuntimePlatform). Never rejects. */
export function detectRuntimePlatform(
  runtime: PlatformInfoSource | undefined,
  limitMs: number = PLATFORM_ANSWER_LIMIT_MS,
): Promise<RuntimePlatform> {
  return askRuntimePlatform(runtime, limitMs).bounded;
}

/** Firefox for Android: the Firefox build, on a platform the browser reports as Android. */
export function isFirefoxAndroid(
  isFirefox: boolean,
  platform: RuntimePlatform,
): boolean {
  return isFirefox && platform === "android";
}

/** The platform for this build (bounded). Chromium resolves to desktop without asking the browser. */
export function runtimePlatformFor(
  isFirefox: boolean,
  runtime: PlatformInfoSource | undefined,
): Promise<RuntimePlatform> {
  return runtimePlatformAnswerFor(isFirefox, runtime).bounded;
}

/** Both forms of the answer for this build. Chromium is desktop at once, without asking. */
export function runtimePlatformAnswerFor(
  isFirefox: boolean,
  runtime: PlatformInfoSource | undefined,
): PlatformAnswer {
  return isFirefox ? askRuntimePlatform(runtime) : KNOWN_DESKTOP;
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
 * reports it unavailable (no re-implementation there), so the gate fails closed: on Firefox it
 * opens only on an explicit "desktop" answer. Chromium is open and known at once.
 * `known` turns true when the bounded answer is in (an "unknown" answer leaves the gate closed);
 * `ready` settles at the same moment. A late "desktop" answer reopens the gate for later messages. */
export interface PlatformGate {
  readonly open: boolean;
  readonly known: boolean;
  readonly ready: Promise<void>;
}

export function tabAllowancePlatformGate(
  isFirefox: boolean,
  platform: Promise<RuntimePlatform>,
  eventual: Promise<RuntimePlatform> = platform,
): PlatformGate {
  let open = !isFirefox;
  let known = !isFirefox;
  const ready = isFirefox
    ? platform.then(
        (answer) => {
          open = answer === "desktop";
          known = true;
        },
        () => {
          known = true; // never expected (the answer never rejects); stays closed
        },
      )
    : Promise.resolve();
  if (isFirefox)
    void eventual.then(
      (answer) => {
        if (answer === "desktop") open = true;
      },
      () => {},
    );
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
 * Hold the route's own messages until the bounded platform answer is in (at most one second), then
 * hand them over. Without this, a desktop Firefox page that asked during that window would be told
 * "unavailable" for good. When the answer is "unknown" the held messages go on to a closed gate and
 * are told "unavailable". Other messages pass straight through. A held message the route then
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
