// Text size for the V3 screens (owner decision 51): follow the person's own text-size setting.
//
// The design system scales every V3 font size by one CSS variable, `--text-scale`
// (`calc(Npx * var(--text-scale, 1))`; the token default is 1). This module measures the setting
// the platform exposes to web pages and writes that variable on <html>. Only text grows: widths,
// spacing, switches and icons stay fixed, exactly as the design's large-text frames draw them.
//
// Where the size comes from:
//   - "browser" (Chrome, Firefox, including Firefox for Android): the browser's default font size
//     ("Font size" in settings). Pages see it as the size of the CSS keyword `medium`.
//   - "apple" (the Apple app's web view, Safari's extension pages on iPhone and iPad): the system
//     Text Size, including the larger accessibility sizes. WebKit exposes it to pages as
//     `font: -apple-system-body` (17px at the default size). On a Mac there is no public text-size
//     setting a web page or app can read, so Mac stays at normal size.
//
// The scale is a ratio of two hidden probes, never a single measurement over a fixed number: a
// browser's own text zoom (Firefox "zoom text only", Firefox for Android's font size) or minimum
// font size changes both probes equally and cancels out. The browser already applies those to
// Still's text itself, so reading them here would enlarge text twice. Page zoom is likewise left
// to the browser.
//
// Live changes: WebKit and Chromium restyle open pages when the setting changes, which resizes the
// probe; a ResizeObserver on it re-measures. A return to the page (visibilitychange, pageshow)
// re-measures as well. Never `window.resize`: extension popups fire spurious resize events.
//
// Hosts call `bindTextScale` once, where they commit to a V3 screen and before it mounts. V3
// components never call it, so the component harness (which sets `--text-scale` itself) stays
// independent. Nothing here is stored or sent anywhere.

/** The design's normal size; no setting makes Still smaller than this. */
export const TEXT_SCALE_MIN = 1;
/** Twice the normal size, the largest the design defines (Apple's 200% Larger Text bar). */
export const TEXT_SCALE_MAX = 2;
/** Above this the compact popups scroll as a whole instead of only the site list. */
export const TEXT_SCALE_LARGE_ABOVE = 1.5;

export type TextScaleSource = "browser" | "apple";

export interface TextScaleOptions {
  /** A compact popup (D01/D02): above 1.5× the whole popup scrolls so nothing is clipped. */
  readonly compactPopup?: boolean;
  /** The desktop popup (D01): its "Settings sync" heading grows with the text. */
  readonly desktopPopupHeading?: boolean;
}

/** The design scale for a measured size over its reference size: clamped to [1, 2], 2 decimals.
 * Anything unmeasurable (zero, negative, NaN, infinite) is the normal size. */
export function textScaleFrom(measured: number, reference: number): number {
  if (!Number.isFinite(measured) || !Number.isFinite(reference)) return TEXT_SCALE_MIN;
  if (measured <= 0 || reference <= 0) return TEXT_SCALE_MIN;
  const clamped = Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, measured / reference));
  return Math.round(clamped * 100) / 100;
}

/** A Mac (not an iPad in desktop mode, which also says "Macintosh" but has touch points). */
export function isMacNavigator(
  nav: { readonly userAgent?: string; readonly maxTouchPoints?: number } | undefined,
): boolean {
  return /Macintosh/.test(nav?.userAgent ?? "") && (nav?.maxTouchPoints ?? 0) === 0;
}

const PROBE_BASE =
  "position:absolute;inset-block-start:0;inset-inline-start:0;visibility:hidden;" +
  "pointer-events:none;white-space:nowrap;line-height:1;margin:0;padding:0;border:0;";

const PROBES: Record<TextScaleSource, { readonly measured: string; readonly reference: string }> = {
  browser: {
    measured: "font-family:sans-serif;font-size:medium;",
    reference: "font-family:sans-serif;font-size:16px;",
  },
  apple: {
    measured: "font:-apple-system-body;",
    reference: "font-size:17px;",
  },
};

/** The attribute on <html> the presentation rules key on: present once bound, "large" above 1.5. */
export const TEXT_SCALE_ATTRIBUTE = "data-still-text-scale";

/** Presentation rules that exist only while text scaling is bound. They live here, not in the
 * shared V3 stylesheets, so builds without text scaling keep those stylesheets unchanged. */
export function textScaleRules(options: TextScaleOptions): string {
  // Above 1.5× a single long word can be wider than a 320px column (at 2×, "recommendations" in
  // "Explore recommendations" overflows the settings page by 4px). Let such a word break rather
  // than run off the edge. Nothing changes at 1.5× or below, so the approved frames are untouched.
  const rules: string[] = [
    `html[${TEXT_SCALE_ATTRIBUTE}="large"] .still-ui{overflow-wrap:anywhere}`,
  ];
  if (options.compactPopup) {
    // Above 1.5× the fixed parts of a compact popup can outgrow its 600px cap. The
    // whole popup then scrolls (the existing invitation-scroll behaviour), and the site list keeps
    // room for one row, so nothing is ever clipped.
    rules.push(
      `html[${TEXT_SCALE_ATTRIBUTE}="large"] .app[data-density="compact"]{overflow-y:auto;overscroll-behavior-y:contain}`,
      `html[${TEXT_SCALE_ATTRIBUTE}="large"] .app[data-density="compact"] .site-scroll{min-block-size:calc(var(--tap-target, 44px) * var(--text-scale, 1) + 2 * var(--service-card-padding-block, var(--space-3, 12px)))}`,
    );
  }
  if (options.desktopPopupHeading) {
    // The desktop popup's own "Settings sync" heading is a fixed 17px in the approved
    // D01 cascade; it grows with the text like every other heading. 17px at the normal size, so
    // the approved frames are unchanged. The D28 invitation variant already scales its heading.
    rules.push(
      `html[${TEXT_SCALE_ATTRIBUTE}] .app[data-density="compact"]:not(.d28-invitation)>.card>.sync-row>.sync-row-text>.sync-row-title{font-size:calc(17px * var(--text-scale, 1))}`,
    );
  }
  return rules.join("\n");
}

/**
 * Measure the person's text size, write `--text-scale` on <html>, and keep it current. Returns a
 * function that removes everything it added. Never throws: if anything cannot be measured the
 * page keeps the design's normal size.
 */
export function bindTextScale(
  doc: Document,
  source: TextScaleSource,
  options: TextScaleOptions = {},
): () => void {
  const added: Element[] = [];
  const cleanups: (() => void)[] = [];
  const root = doc.documentElement;
  const dispose = (): void => {
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* removing is best-effort */
      }
    }
    for (const element of added.splice(0)) element.remove();
  };
  try {
    const win = doc.defaultView;
    const body = doc.body;
    if (!win || !body) return dispose;
    // Mac: no public text-size signal exists; stay at the normal size.
    if (source === "apple" && isMacNavigator(win.navigator)) return dispose;

    const probe = (role: "measured" | "reference", style: string): HTMLElement => {
      const element = doc.createElement("span");
      element.setAttribute("aria-hidden", "true");
      element.setAttribute("data-still-text-probe", role);
      element.textContent = "M";
      element.style.cssText = PROBE_BASE + style;
      body.appendChild(element);
      added.push(element);
      return element;
    };
    const measured = probe("measured", PROBES[source].measured);
    const reference = probe("reference", PROBES[source].reference);
    const sizeOf = (element: HTMLElement): number =>
      parseFloat(win.getComputedStyle(element).fontSize);

    const style = doc.createElement("style");
    style.setAttribute("data-still-text-scale-rules", "");
    style.textContent = textScaleRules(options);
    doc.head.appendChild(style);
    added.push(style);

    let current: number | undefined;
    const apply = (): void => {
      let next: number;
      try {
        next = textScaleFrom(sizeOf(measured), sizeOf(reference));
      } catch {
        return;
      }
      if (next === current) return;
      current = next;
      root.style.setProperty("--text-scale", String(next));
      root.setAttribute(TEXT_SCALE_ATTRIBUTE, next > TEXT_SCALE_LARGE_ABOVE ? "large" : "");
    };
    cleanups.push(() => {
      root.style.removeProperty("--text-scale");
      root.removeAttribute(TEXT_SCALE_ATTRIBUTE);
    });
    apply();

    const Observer = (win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (Observer) {
      const observer = new Observer(() => apply());
      observer.observe(measured);
      cleanups.push(() => observer.disconnect());
    }
    const onReturn = (): void => {
      if (doc.visibilityState !== "hidden") apply();
    };
    doc.addEventListener("visibilitychange", onReturn);
    win.addEventListener("pageshow", onReturn);
    cleanups.push(() => {
      doc.removeEventListener("visibilitychange", onReturn);
      win.removeEventListener("pageshow", onReturn);
    });
  } catch {
    dispose();
  }
  return dispose;
}
