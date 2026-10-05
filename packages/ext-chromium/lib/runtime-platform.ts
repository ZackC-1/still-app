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
 * local call and normally arrives at once; this only keeps a page from waiting forever on it. */
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
 * nothing is offered on a platform that turns out to be Android; Chromium is open at once. */
export function tabAllowancePlatformGate(
  isFirefox: boolean,
  platform: Promise<RuntimePlatform>,
): { readonly open: boolean } {
  let open = !isFirefox;
  if (isFirefox)
    void platform.then(
      (answer) => {
        open = !isFirefoxAndroid(isFirefox, answer);
      },
      () => {
        open = true; // detectRuntimePlatform never rejects; a rejection here means desktop.
      },
    );
  return {
    get open() {
      return open;
    },
  };
}
