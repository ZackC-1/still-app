// V3 store-image visual check: renders the store canvas renderer
// (docs/release/screenshots/source/v3/render-assets.mjs, comparison mode) and compares each canvas
// with its approved 2x reference PNG using the design package's own compare script.
//
//   STILL_DESIGN_PACKAGE=/abs/path/to/still-design-system-v3.2 node tests/visual/store.mjs
//   pnpm visual:store                       # same, package defaults to build/v3/still-design-system-v3.2
//   node tests/visual/store.mjs --only cws-2   # frame ids from assets.json, comma list ok
//   node tests/visual/store.mjs --self-test    # proves the gate: cws-1 PASSes, then FAILs once the
//                                              # render is shifted 2px (test-only, no product change)
//
// Same rules as tests/visual/run.mjs: deviceScaleFactor 2, pass only when differing pixels * 200
// <= total pixels (0.5%, unrounded), no masks, no reference edits. Store canvases are fixed-pixel
// (per-frame size in assets.json), so the 2x render is compared against its per-frame 2x reference at its native size; the
// store export itself is the 1x render of the same canvas (renderer "export" mode).
//
// LOCAL ONLY, not CI: the pixels depend on the machine's font rasteriser and the local, gitignored
// design package. The script prints SKIPPED and exits 0 when the package is absent. Reference
// frames with no renderer are listed as "not mapped" with the reason, never forced.
//
// Output (gitignored): tests/visual/.output/store/{report.json,report.md,impl/*.png,diff/*.png}
// Exit code: 0 when every mapped frame passes or the package is absent, 1 on any failure.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const PKG = resolve(
  process.env.STILL_DESIGN_PACKAGE ??
    resolve(REPO, "build/v3/still-design-system-v3.2"),
);
const OUT = resolve(
  process.env.STILL_VISUAL_OUTPUT ?? join(HERE, ".output"),
  "store",
);
const COMPARE = join(PKG, "handoff/compare.script");
const REFERENCES = join(PKG, "handoff/reference");
const RENDERER = join(
  REPO,
  "docs/release/screenshots/source/v3/render-assets.mjs",
);
const MANIFEST = JSON.parse(
  readFileSync(
    join(REPO, "docs/release/screenshots/source/v3/assets.json"),
    "utf8",
  ),
);

const args = process.argv.slice(2);
let selfTest = false;
let onlyGiven = false;
let onlyIds = [];
const badArgs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--self-test") selfTest = true;
  else if (a === "--only" || a.startsWith("--only=")) {
    onlyGiven = true;
    const value =
      a === "--only" ? (args[++i] ?? "") : a.slice("--only=".length);
    onlyIds.push(...value.split(",").filter(Boolean));
  } else badArgs.push(a);
}
if (badArgs.length) {
  console.error(
    `Usage error: unrecognized argument(s) ${badArgs.join(" ")}. Use --only <ids>, --only=<ids> or --self-test.`,
  );
  process.exit(2);
}
const only = selfTest ? ["cws-1"] : onlyIds;
const unknown = only.filter((id) => !MANIFEST.frames.some((f) => f.id === id));
if (unknown.length || (onlyGiven && !selfTest && !only.length)) {
  console.error(
    `Usage error: unknown --only frame id(s) ${unknown.join(", ") || "(none given)"}. ` +
      `Known: ${MANIFEST.frames.map((f) => f.id).join(", ")}`,
  );
  process.exit(2);
}

if (!existsSync(COMPARE) || !existsSync(join(PKG, "tokens/tokens.json"))) {
  console.log(
    `SKIPPED: V3 design package not found at ${PKG} (set STILL_DESIGN_PACKAGE). No frames compared.`,
  );
  process.exit(0);
}
const { PNG } = createRequire(join(PKG, "package.json"))("pngjs");

const STORE_DIR = "d41-d43-d45-store-assets-and-icons";
// Every reference in the store page, so nothing is silently omitted. Frames without a renderer say why.
const NOT_MAPPED = {
  "09-firefox-android-illustrative-1280-800.png":
    "no renderer: an illustrative Android frame with no manifest entry",
};

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
  if (!counted) return { error: output || `compare exited ${run.status}` };
  const { width, height } = pngSize(reference);
  const differing = Number(counted[2]);
  return {
    differing,
    total: width * height,
    percent: (100 * differing) / (width * height),
    passed: differing * 200 <= width * height,
  };
}

/** Bounding boxes (device px) of connected clusters of the pure-red pixels the compare script paints. */
function regions(diffFile, cell = 24) {
  const png = PNG.sync.read(readFileSync(diffFile));
  const cols = Math.ceil(png.width / cell);
  const rows = Math.ceil(png.height / cell);
  const counts = new Map();
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (
        png.data[i] === 255 &&
        png.data[i + 1] === 0 &&
        png.data[i + 2] === 0
      ) {
        const key = Math.floor(y / cell) * cols + Math.floor(x / cell);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  const seen = new Set();
  const boxes = [];
  for (const start of counts.keys()) {
    if (seen.has(start)) continue;
    const stack = [start];
    seen.add(start);
    let px = 0;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -1,
      y1 = -1;
    while (stack.length) {
      const k = stack.pop();
      px += counts.get(k);
      const cx = k % cols,
        cy = Math.floor(k / cols);
      x0 = Math.min(x0, cx * cell);
      y0 = Math.min(y0, cy * cell);
      x1 = Math.max(x1, (cx + 1) * cell);
      y1 = Math.max(y1, (cy + 1) * cell);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx,
            ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const nk = ny * cols + nx;
          if (counts.has(nk) && !seen.has(nk)) {
            seen.add(nk);
            stack.push(nk);
          }
        }
    }
    boxes.push({
      pixels: px,
      x0,
      y0,
      x1: Math.min(x1, png.width),
      y1: Math.min(y1, png.height),
    });
  }
  return boxes.sort((a, b) => b.pixels - a.pixels);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "impl"), { recursive: true });
mkdirSync(join(OUT, "diff"), { recursive: true });

const rows = [];
let selfTestOutcome = null;
// Built from the manifest before any --only filtering, so unselected frames are not "no renderer".
const mappedRefs = new Set(
  MANIFEST.frames.map((f) => f.reference.split("/").pop()),
);
for (const frame of MANIFEST.frames) {
  if (only.length && !only.includes(frame.id)) continue;
  const reference = join(REFERENCES, frame.reference);
  const scratch = mkdtempSync(join(tmpdir(), "still-store-visual-"));
  chmodSync(scratch, 0o700);
  const run = spawnSync(
    process.execPath,
    [
      RENDERER,
      "--id",
      frame.id,
      "--mode",
      "comparison",
      "--design-root",
      PKG,
      "--output-dir",
      scratch,
    ],
    { cwd: REPO, encoding: "utf8" },
  );
  const rendered = join(scratch, `${frame.id}-comparison.png`);
  const row = {
    frame: frame.id,
    reference: frame.reference.split("/").pop(),
    scale: 2,
    canvas: `${(frame.canvas ?? MANIFEST.canvas).width}x${(frame.canvas ?? MANIFEST.canvas).height}`,
  };
  if (run.status !== 0 || !existsSync(rendered)) {
    rows.push({
      ...row,
      status: "ERROR",
      error: (run.stderr || run.stdout).trim().slice(-400),
    });
  } else {
    const impl = join(OUT, "impl", `${frame.id}.png`);
    const diff = join(OUT, "diff", `${frame.id}.png`);
    copyFileSync(rendered, impl);
    const result = compare(reference, impl, diff);
    if (selfTest && result.passed) {
      // Shift the render 2px right (duplicating the left edge) and expect the gate to fail it.
      const png = PNG.sync.read(readFileSync(impl));
      const shifted = new PNG({ width: png.width, height: png.height });
      for (let y = 0; y < png.height; y++)
        for (let x = 0; x < png.width; x++) {
          const from = (y * png.width + Math.max(0, x - 2)) * 4;
          png.data.copy(shifted.data, (y * png.width + x) * 4, from, from + 4);
        }
      const shiftedFile = join(OUT, "impl", `${frame.id}-shifted.png`);
      writeFileSync(shiftedFile, PNG.sync.write(shifted));
      const bad = compare(
        reference,
        shiftedFile,
        join(OUT, "diff", `${frame.id}-shifted.png`),
      );
      selfTestOutcome = {
        baseline: result.percent,
        shifted: bad.percent,
        shiftedFails: bad.passed === false,
      };
    }
    rows.push(
      result.error
        ? { ...row, status: "ERROR", error: result.error }
        : {
            ...row,
            status: result.passed ? "PASS" : "FAIL",
            differing: result.differing,
            total: result.total,
            percent: result.percent,
            regions: result.differing ? regions(diff).slice(0, 8) : [],
          },
    );
  }
  rmSync(scratch, { recursive: true, force: true });
}

const notMapped = readdirSync(join(REFERENCES, STORE_DIR))
  .filter((f) => f.endsWith(".png") && !mappedRefs.has(f))
  .map((f) => ({ reference: f, reason: NOT_MAPPED[f] ?? "no renderer" }));

writeFileSync(
  join(OUT, "report.json"),
  JSON.stringify({ rows, notMapped }, null, 2) + "\n",
);
const md = [
  "# Store image visual report",
  "",
  "| Frame | Reference | Scale | Diff % | Differing px | Result |",
  "|---|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r.frame} | ${r.reference} | ${r.scale}x | ${r.percent === undefined ? "-" : r.percent.toFixed(3)} | ${r.differing ?? "-"} | ${r.status}${r.error ? ` (${r.error})` : ""} |`,
  ),
  "",
  "## Largest differing regions (device px)",
  ...rows.flatMap((r) => [
    `- ${r.frame}: ` +
      ((r.regions ?? [])
        .map((b) => `${b.pixels}px @ (${b.x0},${b.y0})-(${b.x1},${b.y1})`)
        .join("; ") || "none"),
  ]),
  "",
  "## Not mapped",
  ...notMapped.map((n) => `- ${n.reference}: ${n.reason}`),
  "",
].join("\n");
writeFileSync(join(OUT, "report.md"), md);
console.log(md);
if (selfTest) {
  const ok = selfTestOutcome?.shiftedFails === true;
  console.log(
    `SELF-TEST ${ok ? "OK" : "BROKEN"}: ${JSON.stringify(selfTestOutcome)} (shifted render must FAIL the gate)`,
  );
  process.exit(ok ? 0 : 1);
}
process.exit(rows.some((r) => r.status !== "PASS") ? 1 : 0);
