// T2 visual runner (the WebKit bundle lane): captures the BUILT Safari extension pages (popup and
// settings, from dist/safari-mv3) and the BUILT Apple web view (app-webview dist/index.html) in
// Playwright WebKit at deviceScaleFactor 2, each with a recorded native state behind it
// (tests/qa/webkit/shim), framed by V1's own review frame, and compares each capture with the
// design package's 2x reference using the package's own compare.script and the V1 gate unchanged
// (../gate.mjs: differing pixels * 200 <= total pixels, no masks, no reference edits).
//
//   node tests/visual/real/webkit/run.mjs                    # every T2 frame
//   node tests/visual/real/webkit/run.mjs --only d02,d12     # case ids starting with a prefix
//   node tests/visual/real/webkit/run.mjs --self-test        # proves the gate fails a 2px shift
//   node tests/visual/real/webkit/run.mjs --app-entry emitted-chunk
//        DIAGNOSTIC ONLY: Apple frames from the identical-source chunk Vite emitted beside the
//        shipped page (see tests/qa/webkit/README.md, "Findings"). Never a verdict.
//   STILL_DESIGN_PACKAGE=/abs/path node tests/visual/real/webkit/run.mjs
//
// Build first (the V3 opt-in builds; default builds fold these screens away):
//   VITE_APPLE_ATOMIC_SETTINGS=true pnpm --filter @still/ext-safari build
//   VITE_APPLE_ATOMIC_SETTINGS=true pnpm --filter @still/app-webview build
// Needs Playwright's WebKit (pnpm exec playwright install webkit). Opt-in: not part of CI.
//
// The design package is private. Missing or stale inputs fail before browser launch.
// Output (gitignored): tests/visual/real/webkit/.output/{report.json,report.md,impl,diff}
// Exit code: 0 when every required frame passes, 1 when inputs are invalid or any frame
// fails or is BLOCKED, 2 for a usage or setup error. BLOCKED frames are listed with the reason, never passes.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cases } from "./cases.mjs";
import { recipes } from "./recipes.mjs";
import { designInputs, buildLineage, assertBuildStable, assertReferencesStable, coverageLedger } from "../inputs.mjs";
import { inventoryProblems } from "../validate-frames.mjs";
import { compare, pngSize, withinGate } from "../gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
let inputs;
try { inputs = designInputs(REPO); } catch (error) { console.error(error.message); process.exit(1); }
const { pkg: PKG, references: REFERENCES, compareScript: COMPARE, tooling: TOOLING } = inputs;
const FRAME_MAP = resolve(HERE, "../frames.json");
const SELF_TEST_CASE = "d02-01";

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const KNOWN = new Set(["--only", "--self-test", "--app-entry"]);
const unknown = args.filter((a, i) => a.startsWith("--") && !KNOWN.has(a) && !(i > 0 && ["--only", "--app-entry"].includes(args[i - 1])));
if (unknown.length) {
  console.error(`Unknown option ${unknown.join(", ")}. Use --only <prefixes>, --self-test or --app-entry emitted-chunk.`);
  process.exit(2);
}
const only = (valueOf("--only") ?? "").split(",").filter(Boolean);
const selfTest = args.includes("--self-test");
const appEntry = valueOf("--app-entry") ?? "shipped";
if (!["shipped", "emitted-chunk"].includes(appEntry)) {
  console.error(`--app-entry must be "shipped" or "emitted-chunk", not "${appEntry}".`);
  process.exit(2);
}
const diagnostic = appEntry !== "shipped";
const OUT = resolve(process.env.STILL_VISUAL_REAL_OUTPUT ?? join(HERE, ".output", diagnostic ? "diagnostic-emitted-chunk" : ""));

// Every case that claims a frame id must agree with the frame-to-tier map, when it exists.
if (existsSync(FRAME_MAP)) {
  const frameMap = JSON.parse(readFileSync(FRAME_MAP, "utf8"));
  const problems = inventoryProblems(frameMap, inputs.frames);
  if (problems.length) { console.error(`FAIL: ${problems.join("; ")}`); process.exit(1); }
  const map = new Map(frameMap.frames.map((f) => [f.id, f]));
  const bad = cases.filter((c) => !c.twin && map.has(c.id) && !c.reference.endsWith(map.get(c.id).file));
  if (bad.length) {
    console.error(`Cases disagree with frames.json: ${bad.map((c) => c.id).join(", ")}`);
    process.exit(2);
  }
}

// One Vite server: it serves the framing page (V1's Frame.svelte) and loads the lane's TypeScript
// harness (the shim and its native model) for this plain-Node runner. Both come from the
// repository's existing dev dependencies (the same ones V1 uses).
const coreRequire = createRequire(join(REPO, "packages/core/package.json"));
const importCore = (id) => import(pathToFileURL(coreRequire.resolve(id)).href);
const { createViteServer } = await importCore("vitest/node");
const { svelte, vitePreprocess } = await importCore("@sveltejs/vite-plugin-svelte");
const server = await createViteServer({
  configFile: false,
  root: join(HERE, "host"),
  logLevel: "error",
  plugins: [svelte({ configFile: false, preprocess: vitePreprocess() })],
  resolve: { alias: { "@still/shared-types": join(REPO, "packages/shared-types/src/index.ts") } },
  define: { __STILL_DESIGN_PACKAGE__: JSON.stringify(PKG) },
  server: { port: 0, host: "127.0.0.1", fs: { allow: [REPO, PKG] } },
});
await server.listen();
const base = server.resolvedUrls.local[0];
const harness = await server.ssrLoadModule(join(REPO, "tests/qa/webkit/harness.ts"));

const problems = harness.buildProblems();
if (problems.length) {
  console.error(`The WebKit lane needs the V3 opt-in builds:\n  - ${problems.join("\n  - ")}\nBuild them with:\n  ${harness.BUILD_COMMANDS.join("\n  ")}`);
  await server.close();
  process.exit(2);
}


const builds = { safari: buildLineage(REPO, harness.SAFARI_EXTENSION), apple: buildLineage(REPO, harness.APPLE_WEBVIEW) };
const stable = () => { assertReferencesStable(inputs); return { safari: assertBuildStable(REPO, builds.safari), apple: assertBuildStable(REPO, builds.apple) }; };
const boxes = new Map(inputs.frames.map((f) => [f.file, f]));
const boxOf = (c) => boxes.get(c.reference);

let browser;
try {
  browser = await harness.launchWebKit();
} catch (error) {
  console.error(`Playwright WebKit is not available (${String(error).split("\n")[0]}). Install it with: pnpm exec playwright install webkit`);
  await server.close();
  process.exit(2);
}

function pageUrl(lane, c) {
  if (c.surface === "safari-popup") return lane.safariUrl("popup");
  if (c.surface === "safari-options") return lane.safariUrl("options");
  return lane.appUrl(appEntry);
}

/**
 * When a page never reached its state, say whether it rendered anything at all, and for the Apple
 * web view whether the shipped page still carries Vite's unreplaced preload placeholder (a module
 * that references it throws as soon as it loads a screen; README "Findings").
 */
async function blankPageNote(frame, c) {
  const empty = await frame
    .evaluate(() => (document.getElementById("app")?.childElementCount ?? 0) === 0)
    .catch(() => false);
  if (!empty) return "";
  const placeholder =
    c.surface === "app" && appEntry === "shipped" &&
    readFileSync(join(harness.APPLE_WEBVIEW, "index.html"), "utf8").includes("__VITE_PRELOAD__");
  return placeholder
    ? "; the built page rendered nothing: dist/index.html's inlined module calls the unreplaced Vite placeholder __VITE_PRELOAD__ (ReferenceError) when it loads the D12/D04 screens"
    : "; the built page rendered nothing";
}

/** Capture one case: the framed page, screenshotted at the reference's CSS size and 2x. */
async function capture(c, file, { perturb = 0 } = {}) {
  stable();
  const reference = join(REFERENCES, c.reference);
  const { width: pw, height: ph } = pngSize(reference);
  const box = boxOf(c);
  const lane = await harness.openLane(browser, {
    state: c.state,
    colorScheme: c.theme,
    viewport: { width: 1600, height: 1100 },
    // The device the frame depicts: pages that read window.screen see that device, not the
    // framing page's large viewport.
    ...(c.screen ? { screen: c.screen } : {}),
  });
  const errors = [];
  try {
    const page = await lane.context.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    const params = new URLSearchParams({
      spec: JSON.stringify(c.frame),
      theme: c.theme,
      page: c.page,
      src: pageUrl(lane, c),
      x: String(box?.bounding_box.x ?? 40),
      y: String(box?.bounding_box.y ?? 40),
      ...(c.frame.kind === "popup" ? { frameHeight: String(box?.bounding_box.height ?? ph / 2) } : {}),
    });
    await page.goto(`${base}?${params}`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__t2Ready === true || window.__t2Error, null, { timeout: 15_000 });
    const failure = await page.evaluate(() => window.__t2Error ?? null);
    if (failure) throw new Error(failure);
    const handle = await page.locator("[data-page-under-test]").elementHandle();
    const frame = await handle.contentFrame();
    await frame.waitForLoadState("load");
    try {
      await recipes[c.recipe]({ page, frame, lane });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message.split("\n")[0] : String(error)}${await blankPageNote(frame, c)}`, { cause: error });
    }
    const fontLoaded = await frame.evaluate(() => document.fonts.check('16px "InterVariable"'));
    if (perturb) await frame.addStyleTag({ content: `html{transform:translateX(${perturb}px)}` });
    const shot = page.locator("[data-visual-frame]");
    await shot.screenshot({ path: file, animations: "disabled", caret: "hide" });
    const { width, height } = pngSize(file);
    return {
      fontLoaded,
      errors,
      size: { width, height },
      sizeMatches: width === pw && height === ph,
      native: lane.model.log.map((m) => `${m.surface}:${m.message?.kind ?? "?"}${m.rejected ? " (rejected)" : ""}`),
    };
  } finally {
    await lane.close();
    stable();
  }
}

async function measure(c, { out = OUT, perturb = 0, referenceOverride } = {}) {
  const row = { id: c.id, reference: c.reference, theme: c.theme, surface: c.surface ?? null, state: c.state ?? null, recipe: c.recipe ?? null, twin: c.twin ?? null };
  if (c.blocked) return { ...row, status: "BLOCKED", reason: c.blocked };
  if (diagnostic && c.surface !== "app") return { ...row, status: "BLOCKED", reason: "diagnostic run covers the Apple web view frames only" };
  const implementation = join(out, "impl", `${c.id}.png`);
  const diff = join(out, "diff", `${c.id}.png`);
  mkdirSync(dirname(implementation), { recursive: true });
  mkdirSync(dirname(diff), { recursive: true });
  try {
    const shot = await capture(c, implementation, { perturb });
    Object.assign(row, { fontLoaded: shot.fontLoaded, pageErrors: shot.errors, implSize: shot.size, native: shot.native });
    row.implementation = relative(REPO, implementation);
    if (c.evidenceOnly) return { ...row, status: "BLOCKED", reason: c.evidenceOnly };
    if (!shot.sizeMatches) return { ...row, status: "FAIL", reason: `capture is ${shot.size.width}x${shot.size.height}, the reference is not` };
    stable();
    const outcome = compare({ pkg: TOOLING, compareScript: COMPARE }, referenceOverride ?? join(REFERENCES, c.reference), implementation, diff);
    stable();
    if (outcome.error) return { ...row, status: "FAIL", reason: outcome.error };
    Object.assign(row, outcome, { diff: relative(REPO, diff) });
    row.status = outcome.passed && row.fontLoaded ? "PASS" : "FAIL";
    row.reason = row.status === "PASS" ? "" : !outcome.passed
      ? `pixel difference above 0.5% (${outcome.differing} of ${outcome.total} px, ${outcome.percent.toFixed(9)}%)`
      : "the package font did not load";
    if (row.status === "FAIL" && shot.errors.length) row.reason += `; page errors: ${shot.errors.join(" | ").slice(0, 300)}`;
  } catch (error) {
    row.status = "FAIL";
    row.reason = `harness: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
  return row;
}

const prepare = (dir) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "impl"), { recursive: true });
  mkdirSync(join(dir, "diff"), { recursive: true });
};

async function finish(code) {
  await browser.close();
  await server.close();
  process.exit(code);
}

if (selfTest) {
  // Proof the gate has teeth on this lane. The reference here is the runner's own clean capture of
  // the built Safari popup (the package's references are never touched). A repeat capture must
  // PASS, the same page shifted by 2px must FAIL the 0.5% gate, and the verdict rule must flip
  // exactly at the 0.5% boundary.
  const c = cases.find((entry) => entry.id === SELF_TEST_CASE);
  const dir = join(OUT, "self-test");
  prepare(dir);
  const own = join(dir, "own-reference.png");
  await capture(c, own);
  const clean = await measure(c, { out: join(dir, "clean"), referenceOverride: own });
  const shifted = await measure(c, { out: join(dir, "shifted"), perturb: 2, referenceOverride: own });
  const boundary = withinGate(1000, 200000) === true && withinGate(1001, 200000) === false;
  for (const r of [clean, shifted])
    console.log(`${r.status}  ${r.id}${r === shifted ? " shifted 2px" : ""}  ${r.percent?.toFixed(9) ?? "n/a"}%  ${r.reason}`);
  const ok = clean.status === "PASS" && shifted.status === "FAIL" && shifted.reason.startsWith("pixel difference above 0.5%") && boundary;
  console.log(
    ok
      ? "SELF-TEST OK: an identical render passes, a 2px-shifted render fails, and the gate flips exactly at 0.5%."
      : "SELF-TEST FAILED: the gate did not separate the clean and shifted renders.",
  );
  stable();
  await finish(ok ? 0 : 1);
}

const selected = cases.filter((c) => only.length === 0 || only.some((prefix) => c.id.startsWith(prefix)));
if (selected.length === 0) {
  console.error(`No case id starts with ${only.map((o) => `"${o}"`).join(", ")}.`);
  await finish(2);
}
prepare(OUT);

const results = [];
for (const c of selected) {
  const row = await measure(c);
  results.push(row);
  const pct = row.percent === undefined ? "n/a" : `${row.percent.toFixed(9)}%`;
  console.log(`${row.status}  ${c.id}${c.twin ? " (twin)" : ""}  ${pct}  ${row.reason}`);
}

const required = results.filter((r) => !r.twin);
const counts = {
  compared: required.filter((r) => r.status !== "BLOCKED").length,
  pass: required.filter((r) => r.status === "PASS").length,
  fail: required.filter((r) => r.status === "FAIL").length,
  blocked: required.filter((r) => r.status === "BLOCKED").length,
  twins: results.length - required.length,
};
const buildsAfterCapture = stable();
const summary = {
  generatedAt: new Date().toISOString(),
  tier: "T2 (built bundle in WebKit with a recorded native state)",
  diagnostic: diagnostic ? "DIAGNOSTIC: Apple frames from the emitted chunk, not the shipped page; never a verdict" : null,
  ...inputs.lineage,
  buildLineage: builds,
  buildsAfterCapture,
  coverage: coverageLedger(inputs.frames, cases, results),
  builds: { safari: relative(REPO, harness.SAFARI_EXTENSION), apple: relative(REPO, harness.APPLE_WEBVIEW), appEntry },
  deviceScaleFactor: 2,
  gate: "differing pixels * 200 <= total pixels (pixelmatch threshold 0.1, includeAA false), the package's own compare.script",
  filter: only,
  counts,
  results,
};
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(summary, null, 2)}\n`);
const cell = (v) => String(v ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
writeFileSync(
  join(OUT, "report.md"),
  [
    `# T2 WebKit bundle visual comparison${diagnostic ? " (DIAGNOSTIC, not a verdict)" : ""}`,
    "",
    `Design ${summary.designVersion} · ${summary.builds.safari} + ${summary.builds.apple} (${appEntry}) · WebKit · deviceScaleFactor 2 · ${summary.gate}`,
    "",
    `Required T2 frames: compared ${counts.compared}, ${counts.pass} PASS, ${counts.fail} FAIL; BLOCKED ${counts.blocked}. Twin evidence rows: ${counts.twins}.`,
    "",
    "| Frame | Twin | Theme | State | Diff % | Result | Reason | Capture | Diff image |",
    "|---|---|---|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${cell(r.id)} | ${r.twin ? "yes" : ""} | ${cell(r.theme)} | ${cell(r.state)} | ${r.percent === undefined ? "n/a" : r.percent.toFixed(9)} | ${r.status} | ${cell(r.reason)} | ${cell(r.implementation ?? "")} | ${cell(r.diff ?? "")} |`,
    ),
    "",
  ].join("\n"),
);
console.log(
  `\n${diagnostic ? "DIAGNOSTIC (not a verdict): " : ""}${counts.pass} PASS, ${counts.fail} FAIL, ${counts.blocked} BLOCKED (+${counts.twins} twin rows). Report: ${relative(REPO, join(OUT, "report.md"))}`,
);
await finish(counts.fail > 0 || counts.blocked > 0 || diagnostic || results.some((r) => r.twin && r.status === "FAIL" && r.reason.startsWith("harness")) ? 1 : 0);
