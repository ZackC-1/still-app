// V3 visual harness: renders each merged V3 Svelte screen component in Chromium at
// deviceScaleFactor 2, screenshots the same frame element the design package captured, and
// compares it with the package's 2x reference PNG using the package's own compare script.
//
//   pnpm visual                       # every mapped frame
//   pnpm visual -- --only d01         # case ids starting with "d01" (repeatable, comma list ok)
//   STILL_DESIGN_PACKAGE=/abs/path pnpm visual
//
// The design package is private and gitignored (build/v3/still-design-system-v3.2). When it is
// absent (CI) the run prints SKIPPED and exits 0. Nothing here masks pixels, edits references or
// changes product source: a frame passes only when differing pixels * 200 <= total pixels, the
// same unrounded 0.5% gate as the package's compare script.
//
// Output (gitignored): tests/visual/.output/{report.json,report.md,impl/*.png,diff/*.png}
// Exit code: 0 when every mapped frame passes or the package is absent, 1 when any frame fails.
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
const REFERENCES = join(PKG, "handoff/reference");

const args = process.argv.slice(2);
const only = args
  .flatMap((arg, i) => (args[i - 1] === "--only" ? arg.split(",") : []))
  .filter(Boolean);

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

const registry = await loadRegistry();
const cases = registry.cases.filter(
  (c) => only.length === 0 || only.some((prefix) => c.id.startsWith(prefix)),
);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "impl"), { recursive: true });
mkdirSync(join(OUT, "diff"), { recursive: true });

const results = [];
for (const c of cases) {
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
    theme: inv?.render.theme ?? null,
    width: inv ? inv.bounding_box.width : null,
    textScale: inv ? Number(inv.render.text_scale) : null,
    implTheme: c.theme,
    implWidth: c.width,
    implTextScale: c.textScale,
    deviations: c.deviations ?? [],
    notes: c.notes ?? null,
  };
  try {
    if (!inv || !existsSync(reference))
      throw new Error("reference frame missing from inventory");
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(
      `${base}?case=${encodeURIComponent(c.id)}&x=${inv.bounding_box.x}&y=${inv.bounding_box.y}`,
      { waitUntil: "networkidle" },
    );
    await page.waitForFunction(
      () => window.__visualReady === true || window.__visualError,
      null,
      {
        timeout: 15000,
      },
    );
    const failure = await page.evaluate(() => window.__visualError ?? null);
    if (failure) throw new Error(failure);
    await page.evaluate(() => document.fonts.ready);
    row.fontLoaded = await page.evaluate(() =>
      document.fonts.check('16px "InterVariable"'),
    );
    await page.waitForTimeout(800);
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
    const box = await frame.boundingBox();
    row.implBox = box && { width: box.width, height: box.height };
    row.referenceBox = {
      width: inv.bounding_box.width,
      height: inv.bounding_box.height,
    };
    const implementation = join(OUT, "impl", `${c.id}.png`);
    await frame.screenshot({ path: implementation, animations: "disabled" });
    row.pageErrors = errors;
    await page.close();
    const diff = join(OUT, "diff", `${c.id}.png`);
    const outcome = compare(reference, implementation, diff);
    row.implementation = relative(REPO, implementation);
    if (outcome.error) {
      row.status = "FAIL";
      row.reason = outcome.error;
    } else {
      Object.assign(row, outcome, { diff: relative(REPO, diff) });
      row.status = outcome.passed ? "PASS" : "FAIL";
      row.reason = outcome.passed
        ? ""
        : row.deviations.length
          ? row.deviations.join("; ")
          : "pixel difference above 0.5%";
    }
  } catch (error) {
    row.status = "FAIL";
    row.reason = `harness: ${error instanceof Error ? error.message : String(error)}`;
  }
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
  "| Frame | Caption | Theme | Width | Text scale | Diff % | Result | Reason | Diff image |",
  "|---|---|---|---|---|---|---|---|---|",
  ...results.map(
    (r) =>
      `| ${cell(r.id)} | ${cell(r.caption)} | ${cell(r.theme)} | ${cell(r.width)} | ${cell(r.textScale)} | ${r.percent === undefined ? "n/a" : r.percent.toFixed(9)} | ${r.status} | ${cell(r.reason)} | ${cell(r.diff ?? "")} |`,
  ),
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
