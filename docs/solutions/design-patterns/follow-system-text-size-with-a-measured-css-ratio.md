---
title: Follow the browser or Apple text size by measuring a CSS ratio, not by reading a setting
category: design-patterns
problem_type: design_pattern
track: knowledge
module: packages/core/src/ui/v3
tags: [accessibility, dynamic-type, text-size, wkwebview, safari, chrome, firefox, extension-popup, bundle-identity]
applies_when: A web UI (extension page, popup, or app web view) whose type is px times a scale variable must follow the person's browser font size or Apple Dynamic Type
date: 2026-10-05
status: active
---

# Follow the browser or Apple text size by measuring a CSS ratio, not by reading a setting

## Context

The V3 design scales every font size by one variable: `calc(Npx * var(--text-scale, 1))`. Pixel
font sizes ignore the browser's "Font size" setting and Apple Dynamic Type, so until something sets
the variable the screens stay at 1× everywhere. The aim was one mechanism for Chrome, Firefox,
Safari's extension pages and the Apple app's WKWebView, without a new permission or native code.

## The pattern

`packages/core/src/ui/v3/text-scale.ts` (`bindTextScale`) inserts two hidden probe elements and
writes the ratio of their computed font sizes to `--text-scale` on `<html>`:

| Source | Measured probe | Reference probe | Scale |
|---|---|---|---|
| Chrome / Firefox | `font-size: medium` (follows the browser's default font size) | `font-size: 16px` | ratio, clamped to [1, 2] |
| iPhone / iPad (app web view, Safari pages) | `font: -apple-system-body` (follows Dynamic Type; 17px at Large) | `font-size: 17px` | ratio, clamped to [1, 2] |
| Mac | none (no public text-size signal) | none | 1 |

Why it works:

- **A ratio, not a single value over a constant.** A browser text zoom that scales computed sizes
  (Firefox for Android's font size) grows both probes equally and cancels out. The browser already
  applies that zoom to pixel text, so counting it would enlarge text twice. A minimum font size is
  applied after computed values, so both probes read their normal size and it is never counted.
- **Page zoom is never read.** It shows up as a larger device pixel ratio, not a different CSS font
  size.
- **Live changes need no native code.** WebKit and Chromium restyle open pages when the setting
  changes, which resizes the measured probe. A `ResizeObserver` on it re-measures, with
  `visibilitychange`/`pageshow` as a backup. Never use `window.resize`: extension popups fire
  spurious resize events (Chrome 152).
- **The values land on the design's steps.** iOS body sizes (HIG) over 17 give xxxLarge
  23/17 = 1.35 and AX3+ 40/17 → 2, the design's frames. Chrome "Very large" 24/16 = 1.5.
- **It is synchronous**, so a host can bind before mounting and there is no flash at 1×.

## Evidence

- **iOS 26.2 simulator, Still app web view** (`xcrun simctl ui <sim> content_size …`):
  - `-apple-system-body` measured 17 / 23 / 40 / 16 px at Large / xxxLarge / AX3 / Medium;
  - live while the app was open, after a cold relaunch, and after a change made while backgrounded;
  - the `ResizeObserver` fired on every change;
  - `medium` stayed 16px throughout, so the Apple path must use the system font, not `medium`.
- **Safari tab, same runtime:** 17 → 23 px live.
- **Not verified on the simulator: the Safari extension popup.** There is no scripted way to enable
  an extension there.
- **Chromium:** `tests/playwright/text-scale.spec.ts` seeds `Default/Preferences`
  `{"webkit":{"webprefs":{"default_font_size":N}}}` into the profile before launch. N = 12/16/20/24/32/72
  maps to 1/1/1.25/1.5/2/2.
- **Firefox** (`tests/firefox/text-scale.spec.ts`): `font.size.variable.x-western` 24/32 maps to
  1.5/2.
- **Desktop Firefox cannot reproduce double scaling.** `font.size.systemFontScale` = 150 left page
  text at 16px, and `font.minimum-size.x-western` = 24 grew the rendered glyphs while
  `getComputedStyle` still read 16px for both probes. A Firefox test of it was vacuous: a negative
  control that measured over a fixed 16px still passed it. The guard is the binder unit test where
  both probes read 24px and the scale must stay 1; that same mutation fails it. Firefox for Android
  needs the emulator.

## Gotchas

- **Keep shipped builds byte-identical with inline build-time conditions.** Configured Chrome and
  Firefox builds still contain the V3 chunks, so any edit to a V3 component or shared V3 stylesheet
  changes them.
  - The binder and its presentation rules (whole-popup scroll above 1.5×, a growing desktop sync
    heading, breaking over-long words above 1.5×) live in `text-scale.ts` as an injected `<style>`.
  - Every Chromium entry calls it behind the inline `atomicLocal` condition over
    `import.meta.env`, which Vite folds away in configured builds.
  - Verify with `node scripts/bundles/identity.mjs`.
- **Hosts bind; components never do.** The visual harness sets `--text-scale` itself, and a binder
  inside a component would fight it.
- **On macOS, `-apple-system-body` is a fixed 13px.** The Sonoma Text size setting applies only to
  some Apple apps, and `NSFont.preferredFont` returns fixed sizes. Detect the Mac (desktop user agent
  with no touch points; an iPad web view reports "Macintosh" with touch points) and keep 1.

## Related

- `tests/playwright/text-scale.spec.ts`
- `tests/firefox/text-scale.spec.ts`
- `packages/core/src/ui/v3/text-scale-hosts.test.ts` (binding-site guards)
- `packages/ext-chromium/lib/__tests__/popup-width.test.ts`: the popup width must stay a hard px
  value; text scale never touches it.
