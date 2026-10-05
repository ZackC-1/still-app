import { mount, tick } from "svelte";
import Frame from "./Frame.svelte";
import { SCREENS, OUT_OF_SCOPE } from "./cases/index.js";

declare const __STILL_DESIGN_PACKAGE__: string;
declare global {
  interface Window {
    __visualRegistry?: unknown;
    __visualReady?: boolean;
    __visualError?: string;
  }
}

const params = new URL(location.href).searchParams;
const cases = SCREENS.flatMap((screen) =>
  screen.cases.map((c) => ({ ...c, page: screen.page })),
);

window.__visualRegistry = {
  screens: SCREENS.map((s) => s.screen),
  cases: cases.map(({ render: _render, frame: _frame, ...meta }) => meta),
  unmapped: Object.fromEntries(
    SCREENS.flatMap((s) =>
      Object.entries(s.unmapped ?? {}).map(([file, why]) => [
        `${s.screen}/${file}`,
        why,
      ]),
    ),
  ),
  defaultUnmapped: Object.fromEntries(
    SCREENS.flatMap((s) =>
      s.defaultUnmappedReason ? [[s.screen, s.defaultUnmappedReason]] : [],
    ),
  ),
  outOfScope: OUT_OF_SCOPE,
};

/**
 * Only the reference page's review chrome is applied: page background, link colour, and the
 * frame/device classes. Screen layouts the reference pages also carry (.ob, .steps, .fr) and the
 * simulated focus outlines (.kbd*) are dropped, so the component's own CSS is what gets measured.
 */
const CHROME =
  /^(html|body|a|a:hover|\.r-[\w-]+|\.p-[\w-]+|\.g-[\w-]+)([\s>[:.].*)?$/;
const PRODUCT_INSIDE_CHROME = /\.(ob|steps?|fr|kbd)[\w-]*\b/;

async function chromeStyles(page: string) {
  const root = `/@fs${__STILL_DESIGN_PACKAGE__}`;
  const html = await (await fetch(`${root}/${page}`)).text();
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
    (m) => m[1] ?? "",
  );
  for (const link of html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)) {
    const href = link[1]!;
    if (href.includes("styles.css")) continue; // tokens: the component ships its own copy
    const url = new URL(href, new URL(`${root}/${page}`, location.origin));
    // Without the text/css accept header Vite serves the stylesheet as a JS HMR module.
    css.push(
      await (await fetch(url, { headers: { accept: "text/css" } })).text(),
    );
  }
  const source = new CSSStyleSheet();
  source.replaceSync(css.join("\n"));
  const kept = new CSSStyleSheet();
  for (const rule of source.cssRules) {
    if (!(rule instanceof CSSStyleRule)) continue;
    const selectors = rule.selectorText.split(",").map((s) => s.trim());
    if (
      selectors.every((s) => CHROME.test(s) && !PRODUCT_INSIDE_CHROME.test(s))
    )
      kept.insertRule(rule.cssText, kept.cssRules.length);
  }
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, kept];
}

async function run(id: string) {
  const c = cases.find((entry) => entry.id === id);
  if (!c) throw new Error(`unknown case ${id}`);
  await chromeStyles(c.page);
  const { component, props } = await c.render();
  // The inventory box is where each reference frame sat on its review page; reproducing it keeps
  // the same subpixel phase and scroll-into-view geometry, which measurably affect rasterisation.
  // One frame was captured partly above the viewport (y -50); it keeps only its subpixel phase.
  const x = Number(params.get("x") ?? 0);
  const rawY = Number(params.get("y") ?? 0);
  const y = rawY >= 0 ? rawY : 40 + (rawY - Math.floor(rawY));
  document.body.style.minHeight = `${y + 3000}px`;
  document.body.style.minWidth = `${x + 3000}px`;
  mount(Frame, {
    target: document.getElementById("root")!,
    props: { spec: c.frame, theme: c.theme, x, y, component, props },
  });
  await tick();
  await document.fonts.ready;
  window.__visualReady = true;
}

const id = params.get("case");
if (id)
  run(id).catch((error: unknown) => {
    window.__visualError =
      error instanceof Error
        ? `${error.message}\n${error.stack}`
        : String(error);
  });
