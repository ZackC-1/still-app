// T2 framing page: mounts the V1 harness's own review frame (tests/visual/app/Frame.svelte) with
// the BUILT page in an iframe as its screen. The review chrome (device outline, sheet, title bar,
// home indicator) is drawn exactly as V1 draws it, from the reference page's own stylesheet, so
// the comparison measures the page, not a different frame. Nothing here touches the page itself.
import { mount, tick } from "svelte";
import "../../../../../packages/core/src/ui/v3/design/styles.css";
import Frame from "../../../../visual/app/Frame.svelte";
import type { FrameSpec } from "../../../../visual/app/types.js";
import PageScreen from "./PageScreen.svelte";

declare const __STILL_DESIGN_PACKAGE__: string;
declare global {
  interface Window {
    __t2Ready?: boolean;
    __t2Error?: string;
  }
}

const params = new URL(location.href).searchParams;

// Mirrors chromeStyles() in tests/visual/app/main.ts exactly (keep the two identical): only the
// reference page's review chrome is applied, never its screen layouts or simulated focus outlines.
const CHROME = /^(html|body|a|a:hover|\.r-[\w-]+|\.p-[\w-]+|\.g-[\w-]+)([\s>[:.].*)?$/;
const PRODUCT_INSIDE_CHROME = /\.(ob|steps?|fr|kbd)[\w-]*\b/;

async function chromeStyles(page: string): Promise<void> {
  const root = `/@fs${__STILL_DESIGN_PACKAGE__}`;
  const html = await (await fetch(`${root}/${page}`)).text();
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "");
  for (const link of html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)) {
    const href = link[1]!;
    if (href.includes("styles.css")) continue;
    const url = new URL(href, new URL(`${root}/${page}`, location.origin));
    css.push(await (await fetch(url, { headers: { accept: "text/css" } })).text());
  }
  const source = new CSSStyleSheet();
  source.replaceSync(css.join("\n"));
  const kept = new CSSStyleSheet();
  for (const rule of source.cssRules) {
    if (!(rule instanceof CSSStyleRule)) continue;
    const selectors = rule.selectorText.split(",").map((s) => s.trim());
    if (selectors.every((s) => CHROME.test(s) && !PRODUCT_INSIDE_CHROME.test(s)))
      kept.insertRule(rule.cssText, kept.cssRules.length);
  }
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, kept];
}

async function run(): Promise<void> {
  const spec = JSON.parse(params.get("spec") ?? "null") as FrameSpec;
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  const src = params.get("src");
  if (!spec || !src) throw new Error("missing spec or src");
  await chromeStyles(params.get("page") ?? "");
  // Same placement rule as V1: the inventory box keeps the reference's subpixel phase.
  const x = Number(params.get("x") ?? 0);
  const rawY = Number(params.get("y") ?? 0);
  const y = rawY >= 0 ? rawY : 40 + (rawY - Math.floor(rawY));
  document.body.style.minHeight = `${y + 3000}px`;
  document.body.style.minWidth = `${x + 3000}px`;
  // A popup frame has no fixed height of its own (the popup sizes to its page): the page area is
  // sized so the whole frame, including its own border, is exactly the reference's height.
  const frameHeight = params.get("frameHeight");
  mount(Frame, {
    target: document.getElementById("root")!,
    props: {
      spec,
      theme,
      x,
      y,
      component: PageScreen,
      props: { src, height: frameHeight ? Number(frameHeight) : undefined },
    },
  });
  await tick();
  if (frameHeight) {
    const frame = document.querySelector<HTMLElement>("[data-visual-frame]")!;
    const iframe = document.querySelector<HTMLIFrameElement>("[data-page-under-test]")!;
    const chrome = frame.getBoundingClientRect().height - iframe.getBoundingClientRect().height;
    iframe.style.height = `${Number(frameHeight) - chrome}px`;
  }
  await document.fonts.ready;
  window.__t2Ready = true;
}

run().catch((error: unknown) => {
  window.__t2Error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
});
