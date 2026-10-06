import { test as base, expect, webkit, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// WebKit evidence for the Safari pending cover (packages/core/src/content/pending-cover.ts).
// The maintained module is transpiled as is and started from a document-creation script, the
// closest Playwright WebKit gets to a Safari document_start content script. A red block stands in
// for blocked content; the page background is dark so the canvas colour is observable.
//
// What this proves: WebKit hides the page for the cover, keeps it hidden while settings are
// pending and while a redirect is in flight, shows it at the 1.5 s ceiling, shows it again on its
// own when the script is dead (stylesheet self-expiry), shows the page's own background (no added
// colour), and reveals an allowed page promptly. It does not prove extension injection order,
// Safari storage timing, paint holding during a real navigation, or device behaviour (H-077).

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = resolve(HERE, "../../packages/core/src/content/pending-cover.ts");
const COVER_SOURCE = ts
  .transpileModule(readFileSync(MODULE, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  })
  .outputText.replace(/^export /gm, "");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html { margin: 0; } body { margin: 0; background: rgb(16, 16, 16); }
  #reel { width: 100vw; height: 100vh; background: rgb(255, 0, 0); }
</style></head><body><div id="reel"></div></body></html>`;

interface Scenario {
  /** When the simulated settings read resolves, in ms after document creation; omit = never. */
  readonly decideAt?: number;
  readonly outcome?: "allow" | "redirect";
  /** The script world dies right after showing: no timers, no listeners, class left behind. */
  readonly deadScript?: boolean;
}

// Safari injects document_start content scripts when the document element becomes available
// (WebKit's dispatchDocumentElementAvailable); Playwright's init scripts run earlier, before the
// root exists. The harness waits for the root, which is the Safari injection point it models.
function harness(scenario: Scenario): string {
  return `(() => {
    const begin = () => {
    ${COVER_SOURCE}
    const frames = [];
    const marks = {};
    window.__cover = { frames, marks };
    const start = performance.now();
    const sample = () => {
      const body = document.body;
      frames.push({
        at: performance.now() - start,
        body: !!body,
        opacity: body ? getComputedStyle(body).opacity : null,
        covered: document.documentElement.classList.contains(PENDING_COVER_CLASS),
      });
      if (performance.now() - start < 2500) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    const dead = ${scenario.deadScript === true};
    const cover = createPendingCover({
      doc: document,
      win: window,
      ...(dead ? { setTimer: () => 0, clearTimer: () => {} } : {}),
      onRelease: (why) => { marks.released = performance.now() - start; marks.why = why; },
    });
    marks.bodyAtShow = !!document.body; // recorded honestly; Safari's injection point precedes <body>
    const token = cover.show("pending");
    marks.token = token;
    const decideAt = ${scenario.decideAt ?? "null"};
    if (!dead && decideAt !== null) setTimeout(() => {
      marks.decided = performance.now() - start;
      if (${JSON.stringify(scenario.outcome ?? "allow")} === "redirect") cover.commit(token);
      else cover.release(token, "allowed");
    }, decideAt);
    };
    if (document.documentElement) begin();
    else {
      const observer = new MutationObserver(() => {
        if (!document.documentElement) return;
        observer.disconnect();
        begin();
      });
      observer.observe(document, { childList: true });
    }
  })();`;
}

/** Red pixels in a screenshot, counted by WebKit itself on a scratch page. */
async function redPixels(page: Page, scratch: Page): Promise<number> {
  const png = (await page.screenshot()).toString("base64");
  return scratch.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 200 && pixels[i + 1]! < 60 && pixels[i + 2]! < 60) red++;
    return red;
  }, png);
}

const test = base.extend<{ browser: Browser; open: (scenario: Scenario) => Promise<{ page: Page; scratch: Page }> }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require this destructure form
  browser: async ({}, use) => {
    const browser = await webkit.launch();
    await use(browser);
    await browser.close();
  },
  open: async ({ browser }, use) => {
    await use(async (scenario) => {
      const context = await browser.newContext({ viewport: { width: 400, height: 300 } });
      await context.route("https://cover.test/**", (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: PAGE }));
      await context.addInitScript({ content: harness(scenario) });
      const page = await context.newPage();
      const scratch = await context.newPage();
      await scratch.setContent("<!doctype html><title>scratch</title>");
      await page.goto("https://cover.test/reels/");
      return { page, scratch };
    });
  },
});

type Frame = { at: number; body: boolean; opacity: string | null; covered: boolean };
const frames = (page: Page) => page.evaluate(() => (window as unknown as { __cover: { frames: Frame[] } }).__cover.frames);
const marks = (page: Page) => page.evaluate(() => (window as unknown as { __cover: { marks: Record<string, unknown> } }).__cover.marks);

test("settings pending: no frame shows the page, then the ceiling reveals it at 1.5 s", async ({ open }) => {
  const { page, scratch } = await open({});
  expect(await redPixels(page, scratch)).toBe(0);
  await page.waitForFunction(() => (window as unknown as { __cover: { marks: { released?: number } } }).__cover.marks.released !== undefined);
  const m = await marks(page);
  expect(m.why).toBe("ceiling");
  expect(m.released as number).toBeGreaterThanOrEqual(1_490);
  expect(await redPixels(page, scratch)).toBeGreaterThan(1_000); // the detector does see the page
  const all = await frames(page);
  // The very first frame WebKit rendered with a body was already covered.
  expect(all.find((frame) => frame.body)).toMatchObject({ covered: true, opacity: "0" });
  // Two independent 1.5 s limits end the cover: the script's timer (from the cover's start) and
  // the stylesheet's own animation (from the body's first render). Under machine load the timer can
  // fire a frame or two after the animation already ended, so a frame near 1.5 s may still carry
  // the class with the page visible again; that is the ceiling working, not a flash. Every frame
  // well inside the limit must be hidden.
  const sampled = all.filter((frame) => frame.body && frame.covered && frame.at < 1_400);
  expect(sampled.length).toBeGreaterThan(0);
  expect(sampled.filter((frame) => frame.opacity !== "0"), "a frame inside the limit showed the page").toEqual([]);
  // And nothing is hidden after the cover was released.
  const after = all.filter((frame) => frame.body && frame.at > (m.released as number) + 50);
  expect(after.filter((frame) => frame.opacity === "0"), "hidden after release").toEqual([]);
});

test("redirect in flight: the committed cover stays hidden until the ceiling", async ({ open }) => {
  const { page, scratch } = await open({ decideAt: 200, outcome: "redirect" });
  await page.waitForTimeout(600);
  expect((await marks(page)).released).toBeUndefined();
  expect(await redPixels(page, scratch)).toBe(0);
  await page.waitForFunction(() => (window as unknown as { __cover: { marks: { released?: number } } }).__cover.marks.released !== undefined);
  expect((await marks(page)).why).toBe("ceiling");
});

test("allowed: the page is revealed on the first frame after the decision", async ({ open }) => {
  const { page, scratch } = await open({ decideAt: 300, outcome: "allow" });
  await page.waitForFunction(() => (window as unknown as { __cover: { marks: { released?: number } } }).__cover.marks.released !== undefined);
  await page.waitForTimeout(100);
  const m = await marks(page);
  expect(m.why).toBe("allowed");
  const after = (await frames(page)).filter((frame) => frame.at > (m.released as number));
  expect(after.length).toBeGreaterThan(0);
  expect(after[0]!.opacity).toBe("1");
  expect(await redPixels(page, scratch)).toBeGreaterThan(1_000);
});

test("dead script: the stylesheet alone stops hiding the page after about 1.5 s", async ({ open }) => {
  const { page, scratch } = await open({ deadScript: true });
  expect(await redPixels(page, scratch)).toBe(0);
  await page.waitForTimeout(2_200);
  const last = (await frames(page)).at(-1)!;
  expect(last.covered).toBe(true); // the class was never removed...
  expect(last.opacity).toBe("1"); // ...but the animation has no fill, so it no longer applies
  expect(await redPixels(page, scratch)).toBeGreaterThan(1_000);
  const hiddenUntil = Math.max(...(await frames(page)).filter((frame) => frame.body && frame.opacity === "0").map((frame) => frame.at));
  expect(hiddenUntil).toBeLessThan(2_000);
});

test("the cover adds no colour: the page's own dark background shows", async ({ open }) => {
  const { page, scratch } = await open({});
  const png = (await page.screenshot()).toString("base64");
  const centre = await scratch.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return [...context.getImageData(image.width >> 1, image.height >> 1, 1, 1).data.slice(0, 3)];
  }, png);
  expect((await marks(page)).released).toBeUndefined();
  // The body background (rgb 16,16,16) propagates to the canvas and is not made transparent.
  for (const channel of centre) expect(channel).toBeLessThan(40);
});
