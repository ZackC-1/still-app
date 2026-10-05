import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROBE_MULTIPLE,
  TEXT_SCALE_ATTRIBUTE,
  bindTextScale,
  isMacNavigator,
  textScaleFrom,
  textScaleRules,
} from "./text-scale.js";

const scaleVar = (): string => document.documentElement.style.getPropertyValue("--text-scale");
const attr = (): string | null => document.documentElement.getAttribute(TEXT_SCALE_ATTRIBUTE);

describe("textScaleFrom: the mapping from a platform setting to the design's scale", () => {
  // Chrome's Font size presets and the custom slider (default font size, px) over the 16px reference.
  it.each([
    [9, 1], // Very small: never below the design's normal size
    [12, 1], // Small
    [16, 1], // Medium (default)
    [20, 1.25], // Large
    [24, 1.5], // Very large: the design's 150% frames
    [32, 2], // the design's 2× frames
    [72, 2], // the slider's maximum: capped at twice the normal size
  ])("browser default font size %ipx → %s", (px, scale) => {
    expect(textScaleFrom(px, 16)).toBe(scale);
  });

  // iOS body size per Dynamic Type category (HIG Typography), over the 17px body at Large.
  it.each([
    ["xSmall", 14, 1],
    ["Small", 15, 1],
    ["Medium", 16, 1],
    ["Large (default)", 17, 1],
    ["xLarge", 19, 1.12],
    ["xxLarge", 21, 1.24],
    ["xxxLarge", 23, 1.35], // the design's xxxLarge frames
    ["AX1", 28, 1.65],
    ["AX2", 33, 1.94],
    ["AX3", 40, 2], // the design's accessibility-size frames
    ["AX4", 47, 2],
    ["AX5", 53, 2],
  ])("Dynamic Type %s (body %ipx) → %s", (_name, px, scale) => {
    expect(textScaleFrom(px, 17)).toBe(scale);
  });

  it("cancels a browser's own text zoom, which already enlarges Still's text", () => {
    // Firefox "zoom text only" at 150%, or Firefox for Android's font size: both probes grow.
    expect(textScaleFrom(24, 24)).toBe(1);
    // A larger default font size under the same text zoom still reads as the setting alone.
    expect(textScaleFrom(36, 24)).toBe(1.5);
  });

  it.each([
    [0, 16],
    [-4, 16],
    [Number.NaN, 16],
    [Number.POSITIVE_INFINITY, 16],
    [24, 0],
    [24, Number.NaN],
  ])("an unmeasurable value (%s over %s) is the normal size", (measured, reference) => {
    expect(textScaleFrom(measured, reference)).toBe(1);
  });
});

describe("isMacNavigator", () => {
  it("is a Mac only without touch points", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
    expect(isMacNavigator({ userAgent: mac, maxTouchPoints: 0 })).toBe(true);
    // iPad web views report a desktop user agent but have touch points.
    expect(isMacNavigator({ userAgent: mac, maxTouchPoints: 5 })).toBe(false);
    expect(isMacNavigator({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5 })).toBe(false);
    expect(isMacNavigator(undefined)).toBe(false);
  });
});

describe("textScaleRules", () => {
  it("always lets an over-long word break above 1.5×, and adds nothing else unless asked", () => {
    expect(textScaleRules({})).toBe(
      `html[${TEXT_SCALE_ATTRIBUTE}="large"] .still-ui{overflow-wrap:anywhere}`,
    );
  });

  it("lets a compact popup scroll as a whole only above 1.5×", () => {
    const css = textScaleRules({ compactPopup: true });
    expect(css).toContain(`html[${TEXT_SCALE_ATTRIBUTE}="large"] .app[data-density="compact"]{overflow-y:auto`);
    expect(css).not.toContain("sync-row-title");
  });

  it("grows only the desktop popup's own Settings sync heading, from 17px", () => {
    const css = textScaleRules({ desktopPopupHeading: true });
    expect(css).toContain(":not(.d28-invitation)>.card>.sync-row>.sync-row-text>.sync-row-title");
    expect(css).toContain("font-size:calc(17px * var(--text-scale, 1))");
  });
});

// jsdom does not resolve `medium` or `-apple-system-body`, so the computed font size of each
// probe is supplied here, the way a browser would report it.
let sizes: { measured: number; reference: number };
let observerCallbacks: (() => void)[];
let observed: Element[];
// Every binding a test makes is disposed after it, even when an assertion fails part-way.
let disposers: (() => void)[];
const bind = (...args: Parameters<typeof bindTextScale>): (() => void) => {
  const dispose = bindTextScale(...args);
  disposers.push(dispose);
  return dispose;
};

class FakeResizeObserver {
  constructor(private readonly callback: () => void) {
    observerCallbacks.push(callback);
  }
  observe(element: Element): void {
    observed.push(element);
  }
  disconnect(): void {
    observerCallbacks = observerCallbacks.filter((cb) => cb !== this.callback);
  }
}

function setUserAgent(userAgent: string, maxTouchPoints: number): void {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);
  Object.defineProperty(window.navigator, "maxTouchPoints", { configurable: true, value: maxTouchPoints });
}

describe("bindTextScale", () => {
  beforeEach(() => {
    sizes = { measured: 16, reference: 16 };
    observerCallbacks = [];
    observed = [];
    disposers = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element) => {
      const role = element.getAttribute("data-still-text-probe");
      if (role === "measured" || role === "reference")
        return { fontSize: `${sizes[role]}px` } as CSSStyleDeclaration;
      return real(element);
    });
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64) Chrome/140", 0);
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("style");
    document.documentElement.removeAttribute(TEXT_SCALE_ATTRIBUTE);
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it("writes the scale on <html> before returning, so the screen mounts at the right size", () => {
    sizes = { measured: 24, reference: 16 };
    bind(document, "browser");
    expect(scaleVar()).toBe("1.5");
    expect(attr()).toBe("");
  });

  it("writes the normal size as 1, which equals the design's default", () => {
    bind(document, "browser");
    expect(scaleVar()).toBe("1");
  });

  it("measures against the reference probe, so a text zoom that grows both is not counted twice", () => {
    // Firefox for Android's font size (and any browser text zoom) enlarges both probes; the browser
    // already enlarges Still's text by the same amount.
    sizes = { measured: 24, reference: 24 };
    bind(document, "browser");
    expect(scaleVar()).toBe("1");
    sizes = { measured: 36, reference: 24 };
    for (const callback of observerCallbacks) callback();
    expect(scaleVar()).toBe("1.5");
  });

  it("marks the page large only above 1.5×", () => {
    sizes = { measured: 25, reference: 16 };
    bind(document, "browser");
    expect(scaleVar()).toBe("1.56");
    expect(attr()).toBe("large");
  });

  it("follows a live change through the probe's resize observer", () => {
    bind(document, "apple");
    sizes = { measured: 16, reference: 16 };
    expect(scaleVar()).toBe("1");
    sizes = { measured: 23, reference: 17 };
    for (const callback of observerCallbacks) callback();
    expect(scaleVar()).toBe("1.35");
    sizes = { measured: 40, reference: 17 };
    for (const callback of observerCallbacks) callback();
    expect(scaleVar()).toBe("2");
    expect(attr()).toBe("large");
  });

  it("re-measures when the page becomes visible again", () => {
    bind(document, "apple");
    sizes = { measured: 23, reference: 17 };
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scaleVar()).toBe("1.35");
    sizes = { measured: 17, reference: 17 };
    window.dispatchEvent(new Event("pageshow"));
    expect(scaleVar()).toBe("1");
  });

  it("writes only when the value changes", () => {
    bind(document, "browser");
    const setProperty = vi.spyOn(document.documentElement.style, "setProperty");
    for (const callback of observerCallbacks) callback();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(setProperty).not.toHaveBeenCalled();
  });

  it("keeps a Mac at the normal size and adds nothing to the page", () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 0);
    sizes = { measured: 40, reference: 17 };
    bind(document, "apple", { compactPopup: true });
    expect(scaleVar()).toBe("");
    expect(attr()).toBeNull();
    expect(document.querySelectorAll("[data-still-text-probe], style")).toHaveLength(0);
  });

  it("follows an iPad, whose web view reports a desktop user agent", () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 5);
    sizes = { measured: 23, reference: 17 };
    bind(document, "apple");
    expect(scaleVar()).toBe("1.35");
  });

  it.each([
    ["browser", "medium", "64px"],
    ["apple", null, "68px"],
  ] as const)(
    "%s: measures at four times the normal size, above any minimum font size",
    (source, baseSize, referenceSize) => {
      // Chromium raises computed sizes to its minimum font size (at most 24px); a 16px reference
      // under a 20px minimum read 20px and turned a 24px default into 1.2× instead of 1.5×.
      bind(document, source);
      const base = document.querySelector<HTMLElement>('[data-still-text-probe="base"]')!;
      const measured = document.querySelector<HTMLElement>('[data-still-text-probe="measured"]')!;
      const reference = document.querySelector<HTMLElement>('[data-still-text-probe="reference"]')!;
      expect(PROBE_MULTIPLE).toBe(4);
      expect(measured.parentElement).toBe(base);
      expect(measured.style.fontSize).toBe("4em");
      // jsdom drops the WebKit-only `font: -apple-system-body` shorthand, so only the browser
      // keyword is visible here.
      if (baseSize) expect(base.style.fontSize).toBe(baseSize);
      expect(reference.style.fontSize).toBe(referenceSize);
      expect(reference.parentElement).toBe(document.body);
    },
  );

  it("watches the element set to the platform's size as well as the 4em one", () => {
    // On the iOS simulator WebKit notified only the -apple-system-body element when Text Size changed.
    bind(document, "apple");
    const base = document.querySelector('[data-still-text-probe="base"]');
    const measured = document.querySelector('[data-still-text-probe="measured"]');
    expect(observed).toContain(base);
    expect(observed).toContain(measured);
  });

  it("adds hidden probes and only the rules the host asks for", () => {
    bind(document, "browser", { compactPopup: true });
    const probes = document.querySelectorAll<HTMLElement>("body > [data-still-text-probe]");
    expect(probes).toHaveLength(2);
    for (const probe of probes) {
      expect(probe.getAttribute("aria-hidden")).toBe("true");
      expect(probe.style.visibility).toBe("hidden");
      expect(probe.style.position).toBe("absolute");
    }
    const rules = document.querySelectorAll("style[data-still-text-scale-rules]");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.textContent).toBe(textScaleRules({ compactPopup: true }));
  });

  it("removes everything it added on dispose", () => {
    sizes = { measured: 32, reference: 16 };
    const dispose = bind(document, "browser", { compactPopup: true, desktopPopupHeading: true });
    dispose();
    expect(scaleVar()).toBe("");
    expect(attr()).toBeNull();
    expect(document.querySelectorAll("[data-still-text-probe], style")).toHaveLength(0);
    expect(observerCallbacks).toHaveLength(0);
    sizes = { measured: 24, reference: 16 };
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scaleVar()).toBe("");
  });

  it("never throws: a page that cannot be measured keeps the normal size", () => {
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
      throw new Error("no styles");
    });
    expect(() => bind(document, "browser")).not.toThrow();
    expect(scaleVar()).toBe("");
  });

  it("works without ResizeObserver, re-measuring on return to the page", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    bind(document, "browser");
    sizes = { measured: 20, reference: 16 };
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scaleVar()).toBe("1.25");
  });
});
