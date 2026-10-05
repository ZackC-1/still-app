// V3 visual harness: renders each merged V3 Svelte screen component in Chromium at
// deviceScaleFactor 2, screenshots the same frame element the design package captured, and
// compares it with the package's 2x reference PNG using the package's own compare script.
//
//   pnpm visual                       # every mapped frame
//   pnpm visual -- --only d01         # case ids starting with "d01" (repeatable, comma list ok)
//   STILL_DESIGN_PACKAGE=/abs/path pnpm visual
//   pnpm visual --self-test           # proves the gate: one frame PASSes, then FAILs when the
//                                     # harness shifts its render by 2px (test-only, never product)
//
// The design package is private and gitignored (build/v3/still-design-system-v3.2). When it is
// absent (CI) the run prints SKIPPED and exits 0. Nothing here masks pixels, edits references or
// changes product source: a frame passes only when differing pixels * 200 <= total pixels, the
// same unrounded 0.5% gate as the package's compare script.
//
// Output (gitignored): tests/visual/.output/{report.json,report.md,impl/*.png,diff/*.png}
// Exit code: 0 when every mapped frame passes or the package is absent, 1 when any frame fails,
// 2 for a usage error such as --only matching no case.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const PKG = resolve(
  process.env.STILL_DESIGN_PACKAGE ??
    resolve(HERE, "../../build/v3/still-design-system-v3.2"),
);
const OUT = resolve(process.env.STILL_VISUAL_OUTPUT ?? join(HERE, ".output"));
const COMPARE = join(PKG, "handoff/compare.script");
const INVENTORY = join(PKG, "handoff/reference/render-inventory.json");
const CONTEXT = join(PKG, "handoff/reference/frame-context-inventory.json");
const REFERENCES = join(PKG, "handoff/reference");

const args = process.argv.slice(2);
const only = args
  .flatMap((arg, i) => (args[i - 1] === "--only" ? arg.split(",") : []))
  .filter(Boolean);
const selfTest = args.includes("--self-test");
// The case the self-test perturbs: a frame that matches its reference exactly.
const SELF_TEST_CASE = "d12-01";

if (!existsSync(COMPARE) || !existsSync(INVENTORY)) {
  console.log(
    `SKIPPED: V3 design package not found at ${PKG} (set STILL_DESIGN_PACKAGE). No frames compared.`,
  );
  process.exit(0);
}
for (const dep of ["pngjs", "pixelmatch"]) {
  if (!existsSync(join(PKG, "node_modules", dep))) {
    console.error(
      `The design package's compare script needs its own ${dep}; run "npm i" in ${PKG}.`,
    );
    process.exit(2);
  }
}

// Vite and the Svelte plugin are already installed for @still/core's component tests.
const coreRequire = createRequire(join(REPO, "packages/core/package.json"));
const importCore = (id) => import(pathToFileURL(coreRequire.resolve(id)).href);
const { createViteServer } = await importCore("vitest/node");
const { svelte, vitePreprocess } = await importCore(
  "@sveltejs/vite-plugin-svelte",
);
const { chromium } = await import("@playwright/test");
// Read diff images with the package's own pngjs (no new repository dependency).
const { PNG } = createRequire(join(PKG, "package.json"))("pngjs");

const server = await createViteServer({
  configFile: false,
  root: join(HERE, "app"),
  logLevel: "error",
  plugins: [svelte({ configFile: false, preprocess: vitePreprocess() })],
  resolve: {
    alias: {
      "@still/shared-types": join(REPO, "packages/shared-types/src/index.ts"),
    },
  },
  define: { __STILL_DESIGN_PACKAGE__: JSON.stringify(PKG) },
  server: { port: 0, host: "127.0.0.1", fs: { allow: [REPO, PKG] } },
});
await server.listen();
const base = server.resolvedUrls.local[0];

const inventory = JSON.parse(readFileSync(INVENTORY, "utf8"));
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
const referenceFrames = inventory.inventory.flatMap((page) =>
  page.frames.map((frame) => ({
    ...frame,
    pageName: page.name,
    page: page.page,
    screen: slug(page.name),
  })),
);

const frameContext = existsSync(CONTEXT)
  ? JSON.parse(readFileSync(CONTEXT, "utf8"))
  : { inventory: [] };
const contextFrames = Object.values(frameContext)
  .filter(Array.isArray)
  .flat()
  .flatMap((page) =>
    page.frames.map((frame) => ({ ...frame, screen: slug(page.name) })),
  );
const frameContextOf = (c) =>
  contextFrames.find((f) => f.screen === c.screen && f.output === c.reference);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 2,
});

async function loadRegistry() {
  const page = await context.newPage();
  await page.goto(`${base}?list`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => "__visualRegistry" in window);
  const registry = await page.evaluate(() => window.__visualRegistry);
  await page.close();
  return registry;
}

function pngSize(file) {
  const b = readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function compare(reference, implementation, diff) {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-", reference, implementation, diff],
    { input: readFileSync(COMPARE), cwd: PKG, encoding: "utf8" },
  );
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  const counted = /([\d.]+)% of pixels differ \((\d+)\)/.exec(output);
  if (!counted)
    return {
      error: output || `compare exited ${run.status}`,
      scriptExit: run.status,
    };
  const { width, height } = pngSize(reference);
  const differing = Number(counted[2]);
  return {
    scriptExit: run.status,
    printedPercent: counted[1],
    differing,
    total: width * height,
    percent: (100 * differing) / (width * height),
    passed: differing * 200 <= width * height,
  };
}

/**
 * Differing pixels the package's compare script painted pure red, attributed to each declared
 * deviation's region (device px, inclusive). Pixels inside several regions count once in the
 * union; the remainder is everything outside every declared region.
 */
function attribute(diffFile, regions) {
  const png = PNG.sync.read(readFileSync(diffFile));
  const red = (x, y) => {
    const i = (y * png.width + x) * 4;
    return (
      png.data[i] === 255 && png.data[i + 1] === 0 && png.data[i + 2] === 0
    );
  };
  const inside = (rects, x, y) =>
    rects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
  const per = regions.map(() => 0);
  let inUnion = 0;
  let total = 0;
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      if (!red(x, y)) continue;
      total++;
      let any = false;
      regions.forEach((rects, k) => {
        if (inside(rects, x, y)) {
          per[k]++;
          any = true;
        }
      });
      if (any) inUnion++;
    }
  return { per, remainder: total - inUnion, red: total };
}

async function measure(c, { perturb = 0, out = OUT } = {}) {
  const reference = join(REFERENCES, c.screen, c.reference);
  const inv = referenceFrames.find(
    (f) => f.screen === c.screen && f.output === c.reference,
  );
  const row = {
    id: c.id,
    screen: c.screen,
    reference: relative(PKG, reference),
    caption: inv?.caption ?? c.caption,
    component: c.component,
    referenceTheme: inv?.render.theme ?? null,
    referenceWidth: inv ? inv.bounding_box.width : null,
    // The screen root's --text-scale as the reference recorded it (frame-context inventory),
    // falling back to the captured frame's value when no screen root was recorded.
    referenceTextScale: inv
      ? Number(
          frameContextOf(c)?.section?.ui?.[0]?.textScale ??
            inv.render.text_scale,
        )
      : null,
    deviations: c.deviations ?? [],
    notes: c.notes ?? null,
    callerCopy: c.callerCopy ?? null,
  };
  try {
    if (!inv || !existsSync(reference))
      throw new Error("reference frame missing from inventory");
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(
      `${base}?case=${encodeURIComponent(c.id)}&x=${inv.bounding_box.x}&y=${inv.bounding_box.y}${perturb ? `&perturb=${perturb}` : ""}`,
      { waitUntil: "networkidle" },
    );
    await page.waitForFunction(
      () => window.__visualReady === true || window.__visualError,
      null,
      { timeout: 15000 },
    );
    const failure = await page.evaluate(() => window.__visualError ?? null);
    if (failure) throw new Error(failure);
    await page.evaluate(() => document.fonts.ready);
    row.fontLoaded = await page.evaluate(() =>
      document.fonts.check('16px "InterVariable"'),
    );
    await page.waitForTimeout(800);
    // Real input only (mouse clicks, key presses) to reach states such as an open dialog.
    for (const action of c.actions ?? []) {
      if ("click" in action) await page.locator(action.click).first().click();
      else await page.keyboard.press(action.press);
    }
    if (c.actions?.length) {
      await page.mouse.move(0, 0); // no lingering :hover in the capture
      await page.waitForTimeout(800);
    }
    if (c.focus) {
      // Real keyboard focus (Tab from the top of the document), never a simulated outline.
      let reached = false;
      for (let i = 0; i < (c.focus.maxTabs ?? 40) && !reached; i++) {
        await page.keyboard.press("Tab");
        reached = await page.evaluate(
          (s) => document.activeElement?.matches(s) ?? false,
          c.focus.selector,
        );
      }
      row.focusReached = reached;
      if (!reached) throw new Error(`Tab never reached ${c.focus.selector}`);
      await page.waitForTimeout(300);
    }
    const frame = page.locator("[data-visual-frame]");
    // What actually rendered: the theme governing the screen root, the captured frame's width and
    // the --text-scale the screen root computes. Checked against the reference inventory below.
    const rendered = await frame.evaluate((el, deviations) => {
      const root = el.matches(".still-ui")
        ? el
        : (el.querySelector(".still-ui") ?? el);
      const box = el.getBoundingClientRect();
      const scale = getComputedStyle(root)
        .getPropertyValue("--text-scale")
        .trim();
      const regions = deviations.map((d) => {
        if (typeof d === "string" || (!d.selector && !d.text)) return null;
        const pad = d.pad ?? 2;
        const hits = d.selector
          ? [...el.querySelectorAll(d.selector)]
          : [...el.querySelectorAll("*")].filter((n) =>
              [...n.childNodes].some(
                (t) => t.nodeType === 3 && t.textContent.includes(d.text),
              ),
            );
        return hits
          .map((n) => n.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({
            x0: Math.floor((r.left - box.left - pad) * 2),
            y0: Math.floor((r.top - box.top - pad) * 2),
            x1: Math.ceil((r.right - box.left + pad) * 2),
            y1: Math.ceil((r.bottom - box.top + pad) * 2),
          }));
      });
      return {
        theme:
          root.closest("[data-theme]")?.getAttribute("data-theme") ?? "light",
        width: box.width,
        height: box.height,
        textScale: scale === "" ? 1 : Number(scale),
        regions,
      };
    }, row.deviations);
    row.theme = rendered.theme;
    row.width = rendered.width;
    row.textScale = rendered.textScale;
    row.implBox = { width: rendered.width, height: rendered.height };
    row.referenceBox = {
      width: inv.bounding_box.width,
      height: inv.bounding_box.height,
    };
    const implementation = join(out, "impl", `${c.id}.png`);
    await frame.screenshot({ path: implementation, animations: "disabled" });
    row.pageErrors = errors;
    await page.close();
    const diff = join(out, "diff", `${c.id}.png`);
    const outcome = compare(reference, implementation, diff);
    row.implementation = relative(REPO, implementation);
    const mismatches = [
      row.theme !== row.referenceTheme &&
        `rendered theme ${row.theme} does not match reference ${row.referenceTheme}`,
      Math.abs(row.width - row.referenceWidth) > 0.01 &&
        `rendered width ${row.width} does not match reference ${row.referenceWidth}`,
      row.textScale !== row.referenceTextScale &&
        `rendered text scale ${row.textScale} does not match reference ${row.referenceTextScale}`,
    ].filter(Boolean);
    if (outcome.error) {
      row.status = "FAIL";
      row.reason = [outcome.error, ...mismatches].join("; ");
    } else {
      Object.assign(row, outcome, { diff: relative(REPO, diff) });
      const parts = [];
      if (!outcome.passed)
        parts.push(
          `pixel difference above 0.5% (${outcome.differing} of ${outcome.total} px, ${outcome.percent.toFixed(9)}%)`,
        );
      parts.push(...mismatches);
      if (row.deviations.length) {
        const declared = row.deviations.map((d) =>
          typeof d === "string" ? { reason: d } : d,
        );
        const measurable = rendered.regions.map((r) => r ?? []);
        const { per, remainder } = attribute(diff, measurable);
        row.contributions = declared.map((d, k) => ({
          reason: d.reason,
          pixels: rendered.regions[k] ? per[k] : null,
        }));
        row.remainder = remainder;
        row.remainderPercent = (100 * remainder) / outcome.total;
        row.remainderWithinGate = remainder * 200 <= outcome.total;
        if (!outcome.passed) {
          parts.push(
            `known contributing differences: ${row.contributions
              .map((k) =>
                k.pixels === null
                  ? `${k.reason} (no measurable region)`
                  : `${k.reason} (${k.pixels} px in its region)`,
              )
              .join("; ")}`,
          );
          parts.push(
            row.remainderWithinGate
              ? `remainder outside declared regions ${remainder} px (${row.remainderPercent.toFixed(9)}%), within the 0.5% budget`
              : `unexplained remainder: ${remainder} px (${row.remainderPercent.toFixed(9)}%) outside declared regions, above the 0.5% budget`,
          );
        }
      }
      if (!outcome.passed && row.notes) parts.push(`observed: ${row.notes}`);
      row.status = outcome.passed && mismatches.length === 0 ? "PASS" : "FAIL";
      row.reason = row.status === "PASS" ? "" : parts.join("; ");
    }
  } catch (error) {
    row.status = "FAIL";
    row.reason = `harness: ${error instanceof Error ? error.message : String(error)}`;
  }
  return row;
}

const registry = await loadRegistry();
const prepare = (dir) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "impl"), { recursive: true });
  mkdirSync(join(dir, "diff"), { recursive: true });
};

if (selfTest) {
  const c = registry.cases.find((entry) => entry.id === SELF_TEST_CASE);
  const clean = join(OUT, "self-test", "clean");
  const shifted = join(OUT, "self-test", "shifted");
  prepare(clean);
  prepare(shifted);
  const before = await measure(c, { out: clean });
  const after = await measure(c, { perturb: 2, out: shifted });
  await browser.close();
  await server.close();
  for (const r of [before, after])
    console.log(
      `${r.status}  ${r.id}${r === after ? " shifted 2px" : ""}  ${r.percent?.toFixed(9) ?? "n/a"}%  ${r.reason}`,
    );
  const ok =
    before.status === "PASS" &&
    after.status === "FAIL" &&
    after.reason.startsWith("pixel difference above 0.5%");
  console.log(
    ok
      ? "SELF-TEST OK: the unmodified render passes and the 2px-shifted render fails the gate."
      : "SELF-TEST FAILED: the gate did not separate the unmodified and shifted renders.",
  );
  process.exit(ok ? 0 : 1);
}

const cases = registry.cases.filter(
  (c) => only.length === 0 || only.some((prefix) => c.id.startsWith(prefix)),
);
if (cases.length === 0) {
  console.error(
    `No case id starts with ${only.map((o) => `"${o}"`).join(", ")}. Case ids look like d01-01 or d29-28.`,
  );
  await browser.close();
  await server.close();
  process.exit(2);
}
prepare(OUT);

const results = [];
for (const c of cases) {
  const row = await measure(c);
  results.push(row);
  const pct = row.percent === undefined ? "n/a" : `${row.percent.toFixed(9)}%`;
  console.log(`${row.status}  ${c.id}  ${pct}  ${row.reason}`);
}
await browser.close();
await server.close();

const mapped = new Set(registry.cases.map((c) => `${c.screen}/${c.reference}`));
const unmapped = referenceFrames
  .filter(
    (f) =>
      registry.screens.includes(f.screen) &&
      !mapped.has(`${f.screen}/${f.output}`),
  )
  .map((f) => ({
    screen: f.screen,
    reference: f.output,
    caption: f.caption,
    reason:
      registry.unmapped[`${f.screen}/${f.output}`] ??
      registry.defaultUnmapped[f.screen] ??
      "no fixture case written for this frame yet",
  }));
const outOfScope = inventory.inventory
  .filter((p) => !registry.screens.includes(slug(p.name)))
  .map((p) => ({
    screen: slug(p.name),
    frames: p.frames.length,
    reason: registry.outOfScope[slug(p.name)] ?? "not in the V1 component list",
  }));

const summary = {
  generatedAt: new Date().toISOString(),
  designPackage: PKG,
  designVersion: inventory.design_version,
  chromium: browser.version(),
  deviceScaleFactor: 2,
  gate: "differing pixels * 200 <= total pixels (pixelmatch threshold 0.1, includeAA false)",
  filter: only,
  counts: {
    compared: results.length,
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    unmapped: unmapped.length,
  },
  results,
  unmapped,
  outOfScope,
};
writeFileSync(
  join(OUT, "report.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);

const cell = (v) =>
  String(v ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
const md = [
  "# V3 visual comparison",
  "",
  `Design ${summary.designVersion} · Chromium ${summary.chromium} · deviceScaleFactor 2 · ${summary.gate}`,
  "",
  `Compared ${summary.counts.compared}: ${summary.counts.pass} PASS, ${summary.counts.fail} FAIL. Unmapped frames: ${summary.counts.unmapped}.`,
  "",
  "Theme, width and text scale are what the implementation rendered; a value that differs from the reference is shown as `rendered (reference X)` and fails the frame.",
  "",
  "| Frame | Caption | Theme | Width | Text scale | Diff % | Result | Reason | Scope | Diff image |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...results.map((r) => {
    const show = (v, ref) =>
      v === undefined ? "n/a" : v === ref ? v : `${v} (reference ${ref})`;
    return `| ${cell(r.id)} | ${cell(r.caption)} | ${cell(show(r.theme, r.referenceTheme))} | ${cell(show(r.width, r.referenceWidth))} | ${cell(show(r.textScale, r.referenceTextScale))} | ${r.percent === undefined ? "n/a" : r.percent.toFixed(9)} | ${r.status} | ${cell(r.reason)} | ${cell(r.callerCopy ?? "")} | ${cell(r.diff ?? "")} |`;
  }),
  "",
  "## Frames not mapped",
  "",
  "| Screen | Reference | Caption | Why |",
  "|---|---|---|---|",
  ...unmapped.map(
    (u) =>
      `| ${cell(u.screen)} | ${cell(u.reference)} | ${cell(u.caption)} | ${cell(u.reason)} |`,
  ),
  "",
  "## Pages outside this harness",
  "",
  ...outOfScope.map((o) => `- ${o.screen} (${o.frames} frames): ${o.reason}`),
  "",
].join("\n");
writeFileSync(join(OUT, "report.md"), md);
console.log(
  `\n${summary.counts.pass} PASS, ${summary.counts.fail} FAIL, ${summary.counts.unmapped} unmapped. Report: ${relative(REPO, join(OUT, "report.md"))}`,
);
process.exit(summary.counts.fail > 0 ? 1 : 0);
