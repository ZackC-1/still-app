import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectRuntimePlatform,
  isFirefoxAndroid,
  popupPresentationLoader,
  runtimePlatformFor,
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
    for (const os of ["mac", "win", "linux", "cros", "openbsd", "fuchsia", "ANDROID", ""])
      expect(await detectRuntimePlatform(runtime(os))).toBe("desktop");
  });

  it("never decides from the window, the screen or the user agent", async () => {
    // A 320px desktop window with a phone user agent and touch is still desktop Firefox.
    narrowWindow(320);
    expect(await detectRuntimePlatform(runtime("mac"))).toBe("desktop");
    expect(await detectRuntimePlatform(undefined)).toBe("desktop");
    expect(await detectRuntimePlatform({})).toBe("desktop");
    // And a wide window cannot hide a real Android answer.
    narrowWindow(1920);
    expect(await detectRuntimePlatform(runtime("android"))).toBe("android");
  });

  it("falls back to desktop when the browser fails, throws or never answers", async () => {
    expect(
      await detectRuntimePlatform({ getPlatformInfo: async () => Promise.reject(new Error("no")) }),
    ).toBe("desktop");
    expect(
      await detectRuntimePlatform({
        getPlatformInfo: () => {
          throw new Error("sync");
        },
      }),
    ).toBe("desktop");
    vi.useFakeTimers();
    const pending = detectRuntimePlatform({ getPlatformInfo: () => new Promise(() => {}) }, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBe("desktop");
  });

  it("the Chromium build never asks the browser and is always desktop", async () => {
    const asked = runtime("android");
    expect(await runtimePlatformFor(false, asked)).toBe("desktop");
    expect(asked.getPlatformInfo).not.toHaveBeenCalled();
    expect(await runtimePlatformFor(true, asked)).toBe("android");
  });

  it("Firefox for Android is the Firefox build on Android only", () => {
    expect(isFirefoxAndroid(true, "android")).toBe(true);
    expect(isFirefoxAndroid(true, "desktop")).toBe(false);
    expect(isFirefoxAndroid(false, "android")).toBe(false);
    expect(isFirefoxAndroid(false, "desktop")).toBe(false);
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
