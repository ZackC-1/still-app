import { afterEach, describe, expect, it, vi } from "vitest";
import { accessCapabilities } from "@still/core/entitlement";
import {
  accessPlatformReader,
  askRuntimePlatform,
  detectRuntimePlatform,
  isFirefoxAndroid,
  popupPresentationLoader,
  runtimePlatformAnswerFor,
  runtimePlatformFor,
  tabAllowancePlatformGate,
  type RuntimePlatform,
} from "../runtime-platform.js";

const runtime = (os: string) => ({ getPlatformInfo: vi.fn(async () => ({ os })) });

/** Make the page look like a phone in every way except the browser's own platform answer. */
function narrowWindow(width: number): void {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("outerWidth", width);
  vi.stubGlobal("screen", { width, height: 780, availWidth: width });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: /max-width/.test(query), media: query }));
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:142.0) Gecko/142.0 Firefox/142.0",
    maxTouchPoints: 5,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runtime platform", () => {
  it("is android only when the browser says android", async () => {
    expect(await detectRuntimePlatform(runtime("android"))).toBe("android");
    for (const os of ["mac", "win", "linux", "cros", "openbsd", "fuchsia"])
      expect(await detectRuntimePlatform(runtime(os))).toBe("desktop");
    // A malformed answer is not a desktop claim: it is unknown (held back, TikTok gate closed).
    for (const os of ["ANDROID", "", "ios", "android-ish"])
      expect(await detectRuntimePlatform(runtime(os)), os).toBe("unknown");
    expect(await detectRuntimePlatform({ getPlatformInfo: async () => ({}) as { os: string } })).toBe("unknown");
  });

  it("never decides from the window, the screen or the user agent", async () => {
    // A 320px desktop window with a phone user agent and touch is still desktop Firefox.
    narrowWindow(320);
    expect(await detectRuntimePlatform(runtime("mac"))).toBe("desktop");
    // No browser answer is "unknown", never a guess from the window.
    expect(await detectRuntimePlatform(undefined)).toBe("unknown");
    expect(await detectRuntimePlatform({})).toBe("unknown");
    // And a wide window cannot hide a real Android answer.
    narrowWindow(1920);
    expect(await detectRuntimePlatform(runtime("android"))).toBe("android");
  });

  it("is unknown when the browser fails, throws or never answers", async () => {
    expect(
      await detectRuntimePlatform({ getPlatformInfo: async () => Promise.reject(new Error("no")) }),
    ).toBe("unknown");
    expect(
      await detectRuntimePlatform({
        getPlatformInfo: () => {
          throw new Error("sync");
        },
      }),
    ).toBe("unknown");
    vi.useFakeTimers();
    const pending = detectRuntimePlatform({ getPlatformInfo: () => new Promise(() => {}) }, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBe("unknown");
  });

  it("keeps the late answer apart from the bounded one", async () => {
    vi.useFakeTimers();
    let late!: (info: { os: string }) => void;
    const answer = askRuntimePlatform({ getPlatformInfo: () => new Promise((r) => (late = r)) }, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await answer.bounded).toBe("unknown");
    late({ os: "mac" });
    expect(await answer.eventual).toBe("desktop");
  });

  it("the Chromium build never asks the browser and is always desktop", async () => {
    const asked = runtime("android");
    expect(await runtimePlatformFor(false, asked)).toBe("desktop");
    expect(asked.getPlatformInfo).not.toHaveBeenCalled();
    const both = runtimePlatformAnswerFor(false, asked);
    expect([await both.bounded, await both.eventual]).toEqual(["desktop", "desktop"]);
    expect(asked.getPlatformInfo).not.toHaveBeenCalled();
    expect(await runtimePlatformFor(true, asked)).toBe("android");
  });

  it("Firefox for Android is the Firefox build on Android only", () => {
    expect(isFirefoxAndroid(true, "android")).toBe(true);
    expect(isFirefoxAndroid(true, "desktop")).toBe(false);
    expect(isFirefoxAndroid(false, "android")).toBe(false);
    expect(isFirefoxAndroid(false, "desktop")).toBe(false);
    // An unknown platform is presented and counted as desktop.
    expect(isFirefoxAndroid(true, "unknown")).toBe(false);
  });
});

describe("Still Pro access platform", () => {
  const DESKTOP_LAYOUT_ONLY = ["youtube.endscreen", "youtube.livechat", "facebook.sponsored"] as const;
  const proFor = (platform: RuntimePlatform) => accessCapabilities({ paidMode: true, host: "firefox", platform });

  it("Firefox for Android never resolves a desktop-layout-only extra; it keeps the phone-layout ones", async () => {
    narrowWindow(390);
    const read = accessPlatformReader(runtimePlatformAnswerFor(true, runtime("android")));
    const platform = await read();
    expect(platform).toBe("android");
    for (const id of DESKTOP_LAYOUT_ONLY) expect(proFor(platform).has(id), id).toBe(false);
    for (const id of ["youtube.autoplay", "youtube.comments", "youtube.related"] as const) expect(proFor(platform).has(id), id).toBe(true);
  });

  it("a narrow desktop Firefox window is still desktop and keeps every extra", async () => {
    narrowWindow(390);
    const read = accessPlatformReader(runtimePlatformAnswerFor(true, runtime("mac")));
    expect(await read()).toBe("desktop");
    for (const id of DESKTOP_LAYOUT_ONLY) expect(proFor(await read()).has(id), id).toBe(true);
  });

  it("Chromium is desktop at once without asking the browser", async () => {
    const source = runtime("android");
    expect(await accessPlatformReader(runtimePlatformAnswerFor(false, source))()).toBe("desktop");
    expect(source.getPlatformInfo).not.toHaveBeenCalled();
  });

  it("a late answer is unknown (held back) until the browser answers, then the answer is used", async () => {
    vi.useFakeTimers();
    let answer!: (info: { os: string }) => void;
    const read = accessPlatformReader(askRuntimePlatform({ getPlatformInfo: () => new Promise((resolve) => { answer = resolve; }) }, 50));
    const first = read();
    await vi.advanceTimersByTimeAsync(60);
    expect(await first).toBe("unknown");
    for (const id of DESKTOP_LAYOUT_ONLY) expect(proFor("unknown").has(id), id).toBe(false);
    answer({ os: "linux" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await read()).toBe("desktop");
  });
});

describe("popup presentation choice", () => {
  const loaders = () => ({
    desktop: vi.fn(async () => "desktop popup"),
    firefoxAndroid: vi.fn(async () => "phone popup"),
  });

  it("gives Firefox for Android the phone popup and loads nothing else", async () => {
    const l = loaders();
    expect(await popupPresentationLoader(true, Promise.resolve("android"), l)()).toBe("phone popup");
    expect(l.desktop).not.toHaveBeenCalled();
  });

  it("keeps desktop Firefox and Chromium on the desktop popup, even in a narrow window", async () => {
    narrowWindow(320);
    for (const [isFirefox, platform] of [
      [true, "desktop"],
      [true, "unknown"],
      [false, "desktop"],
      [false, "android"],
    ] as const) {
      const l = loaders();
      expect(await popupPresentationLoader(isFirefox, Promise.resolve<RuntimePlatform>(platform), l)()).toBe(
        "desktop popup",
      );
      expect(l.firefoxAndroid).not.toHaveBeenCalled();
    }
  });

  it("chooses once from the browser's answer: nothing loads before it arrives", async () => {
    let answer!: (platform: RuntimePlatform) => void;
    const l = loaders();
    const loading = popupPresentationLoader(true, new Promise<RuntimePlatform>((r) => (answer = r)), l)();
    await Promise.resolve();
    expect(l.desktop).not.toHaveBeenCalled();
    expect(l.firefoxAndroid).not.toHaveBeenCalled();
    answer("android");
    expect(await loading).toBe("phone popup");
    expect(l.desktop).not.toHaveBeenCalled();
  });
});

describe("TikTok one-tab allowance platform gate", () => {
  it("Firefox for Android never offers it; desktop Firefox does once the browser has answered", async () => {
    const android = tabAllowancePlatformGate(true, Promise.resolve("android"));
    const desktop = tabAllowancePlatformGate(true, Promise.resolve("desktop"));
    await Promise.resolve();
    expect(android.open).toBe(false);
    expect(desktop.open).toBe(true);
  });

  it("stays closed while the Firefox answer is pending, and Chromium is open at once", async () => {
    let answer!: (platform: RuntimePlatform) => void;
    const pending = tabAllowancePlatformGate(true, new Promise<RuntimePlatform>((r) => (answer = r)));
    expect(pending.open).toBe(false);
    answer("android");
    await Promise.resolve();
    expect(pending.open).toBe(false);
    expect(tabAllowancePlatformGate(false, Promise.resolve("android")).open).toBe(true);
  });

  it("fails closed on an unknown answer and reopens only on a later desktop answer", async () => {
    let late!: (platform: RuntimePlatform) => void;
    const gate = tabAllowancePlatformGate(
      true,
      Promise.resolve("unknown"),
      new Promise<RuntimePlatform>((r) => (late = r)),
    );
    await gate.ready;
    expect(gate).toMatchObject({ known: true, open: false });
    late("desktop");
    await Promise.resolve();
    await Promise.resolve();
    expect(gate.open).toBe(true);
    const android = tabAllowancePlatformGate(true, Promise.resolve("unknown"), Promise.resolve("android"));
    await android.ready;
    await Promise.resolve();
    expect(android.open).toBe(false);
  });
});
