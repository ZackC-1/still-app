// T1 visual runner: captures the REAL built Chrome extension pages (popup opened as a page at the
// popup size, options, first-run, the TikTok blocked page) in Chromium at deviceScaleFactor 2 and
// compares each with the design package's 2x reference PNG, using the package's own compare.script
// and the V1 gate unchanged (differing pixels * 200 <= total pixels, no masks, no reference edits).
//
//   pnpm visual:real                       # every reachable frame
//   pnpm visual:real -- --only d01,d14     # case ids starting with a prefix (comma list ok)
//   pnpm visual:real -- --self-test        # proves the gate separates a clean and a 2px-shifted render
//   STILL_DESIGN_PACKAGE=/abs/path pnpm visual:real
//
// Build the extension first: pnpm --filter @still/ext-chromium build.
// The design package is private. Missing or stale inputs fail before browser launch.
//
// Output (gitignored): tests/visual/real/.output/{report.json,report.md,impl/*.png,diff/*.png}
// Exit code: 0 when every selected frame passes, 1 when inputs are invalid or any frame
// fails or is BLOCKED, 2 for a usage error. BLOCKED frames (state not reachable yet) are listed, never counted
// as passes.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cases } from "./cases.mjs";
import { compare, cropReferenceTop, pngSize, referenceChrome, signInCompiledIn } from "./gate.mjs";
import { Blocked, recipes } from "./recipes.mjs";
import { designInputs, buildLineage, assertBuildStable, assertReferencesStable, coverageLedger } from "./inputs.mjs";
import { caseProblems, inventoryProblems } from "./validate-frames.mjs";
import { CHROMIUM_EXTENSION, extensionIdOf, launchExtension, waitForCommittedSettings } from "../../qa/shared/launch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
let inputs;
try { inputs = designInputs(REPO); } catch (error) { console.error(error.message); process.exit(1); }
const { references: REFERENCES, compareScript: COMPARE, tooling: TOOLING } = inputs;
const OUT = resolve(process.env.STILL_VISUAL_REAL_OUTPUT ?? join(HERE, ".output"));
const FRAME_MAP = join(HERE, "frames.json");

const args = process.argv.slice(2);
const only = args.flatMap((arg, i) => (args[i - 1] === "--only" ? arg.split(",") : [])).filter(Boolean);
const selfTest = args.includes("--self-test");

if (!existsSync(join(CHROMIUM_EXTENSION, "manifest.json"))) {
  console.error(`No built extension at ${CHROMIUM_EXTENSION}. Run: pnpm --filter @still/ext-chromium build`);
  process.exit(2);
}

// When the frame-to-tier map is present, every case must agree with it (id and reference file).
if (existsSync(FRAME_MAP)) {
  const map = JSON.parse(readFileSync(FRAME_MAP, "utf8"));
  const problems = [...caseProblems(cases, map), ...inventoryProblems(map, inputs.frames)];
  if (problems.length) {
    console.error(`Cases disagree with frames.json:\n  ${problems.join("\n  ")}`);
    process.exit(2);
  }
}

const SIGN_IN = signInCompiledIn(CHROMIUM_EXTENSION);
const PACKAGE_COMPARE = { pkg: TOOLING, compareScript: COMPARE };
const build = buildLineage(REPO, CHROMIUM_EXTENSION);
const stable = () => { assertReferencesStable(inputs); return assertBuildStable(REPO, build); };

/** Capture one case; the page is screenshotted at exactly the reference's CSS size and 2x. */
async function capture(c, file, { perturb = 0 } = {}) {
  stable();
  const reference = join(REFERENCES, c.reference);
  const { width: pw, height: ph } = pngSize(reference);
  // A reference that includes browser chrome (a tab strip) is captured without it: the page is
  // laid out where the reference lays it out and photographed from below the strip
  // (frames.json referenceChrome).
  const { top, pageOffset } = referenceChrome(c.id, FRAME_MAP);
  const size = { width: pw / 2, height: Math.ceil(ph / 2) - pageOffset };
  const context = await launchExtension({ deviceScaleFactor: 2, colorScheme: c.theme, locale: c.locale });
  try {
    const id = await extensionIdOf(context);
    await waitForCommittedSettings(context);
    const page = await recipes[c.recipe]({ context, id, size, signIn: SIGN_IN });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const fontLoaded = await page.evaluate(() => document.fonts.check('16px "InterVariable"'));
    if (perturb) await page.addStyleTag({ content: `html{transform:translateX(${perturb}px)}` });
    await page.screenshot({
      path: file,
      animations: "disabled",
      caret: "hide",
      clip: { x: 0, y: top - pageOffset, width: pw / 2, height: ph / 2 - top },
    });
    return { fontLoaded, errors, viewport: size };
  } finally {
    await context.close();
    stable();
  }
}

async function measure(c, { out = OUT, perturb = 0, referenceOverride } = {}) {
  const row = { id: c.id, reference: c.reference, recipe: c.recipe, theme: c.theme };
  if (c.blocked) return { ...row, status: "BLOCKED", reason: c.blocked };
  const implementation = join(out, "impl", `${c.id}.png`);
  const diff = join(out, "diff", `${c.id}.png`);
  mkdirSync(dirname(implementation), { recursive: true });
  mkdirSync(dirname(diff), { recursive: true });
  try {
    const shot = await capture(c, implementation, { perturb });
    Object.assign(row, { fontLoaded: shot.fontLoaded, pageErrors: shot.errors, viewport: shot.viewport });
    const { top } = referenceChrome(c.id, FRAME_MAP);
    const reference = join(REFERENCES, c.reference);
    const compared = referenceOverride ?? (top ? cropReferenceTop(TOOLING, reference, join(out, "impl", `${c.id}.reference.png`), top) : reference);
    if (top) row.referenceCropTopCssPx = top;
    stable();
    const outcome = compare(PACKAGE_COMPARE, compared, implementation, diff);
    stable();
    row.implementation = relative(REPO, implementation);
    if (outcome.error) return { ...row, status: "FAIL", reason: outcome.error };
    Object.assign(row, outcome, { diff: relative(REPO, diff) });
    row.status = outcome.passed && row.fontLoaded ? "PASS" : "FAIL";
    row.reason = row.status === "PASS" ? "" : !outcome.passed
      ? `pixel difference above 0.5% (${outcome.differing} of ${outcome.total} px, ${outcome.percent.toFixed(9)}%)`
      : "the package font did not load";
  } catch (error) {
    if (error instanceof Blocked) return { ...row, status: "BLOCKED", reason: error.message };
    row.status = "FAIL";
    row.reason = `harness: ${error instanceof Error ? error.message : String(error)}`;
  }
  return row;
}

const prepare = (dir) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "impl"), { recursive: true });
  mkdirSync(join(dir, "diff"), { recursive: true });
};

if (selfTest) {
  // Proof the gate has teeth. The reference here is the runner's own clean capture of a real page
  // (the package's references are never touched). A repeat capture must PASS; the same page shifted
  // by 2px must FAIL the 0.5% gate; and the verdict rule must flip exactly at the 0.5% boundary.
  const c = cases.find((entry) => entry.recipe && entry.id === "d14-01");
  const base = join(OUT, "self-test");
  prepare(base);
  const referenceCopy = join(base, "own-reference.png");
  await capture(c, referenceCopy);
  const clean = await measure(c, { out: join(base, "clean"), referenceOverride: referenceCopy });
  const shifted = await measure(c, { out: join(base, "shifted"), perturb: 2, referenceOverride: referenceCopy });
  const { withinGate } = await import("./gate.mjs");
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
  process.exit(ok ? 0 : 1);
}

const selected = cases.filter((c) => only.length === 0 || only.some((prefix) => c.id.startsWith(prefix)));
if (selected.length === 0) {
  console.error(`No case id starts with ${only.map((o) => `"${o}"`).join(", ")}.`);
  process.exit(2);
}
prepare(OUT);

const results = [];
for (const c of selected) {
  const row = await measure(c);
  results.push(row);
  const pct = row.percent === undefined ? "n/a" : `${row.percent.toFixed(9)}%`;
  console.log(`${row.status}  ${c.id}  ${pct}  ${row.reason}`);
}

const counts = {
  compared: results.filter((r) => r.status !== "BLOCKED").length,
  pass: results.filter((r) => r.status === "PASS").length,
  fail: results.filter((r) => r.status === "FAIL").length,
  blocked: results.filter((r) => r.status === "BLOCKED").length,
};
const buildAfterCapture = stable();
const coverage = coverageLedger(inputs.frames, cases, results);
const summary = {
  generatedAt: new Date().toISOString(),
  ...inputs.lineage,
  build,
  buildAfterCapture,
  coverage,
  scopeNotes: [
    "Popup is opened as an extension page at the reference size; this does not certify the browser toolbar popup chrome or native popup sizing.",
    "Reference auth/purchase states require the matching configured QA profile; disabled or unavailable real capabilities remain absent and measured pixel failures remain failures.",
    "Approved supported-surface copy may differ from the reference's every-device/browser copy; no pixels are masked or excluded for that wording.",
  ],
  extension: relative(REPO, CHROMIUM_EXTENSION),
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
    "# T1 real-extension visual comparison",
    "",
    `Design ${summary.designVersion} · ${summary.extension} · deviceScaleFactor 2 · ${summary.gate}`,
    "",
    `Compared ${counts.compared}: ${counts.pass} PASS, ${counts.fail} FAIL. BLOCKED (state not reachable yet): ${counts.blocked}.`,
    "",
    `Latest inventory: ${coverage.length} frames; ${coverage.filter((r) => r.status === "UNMAPPED").length} without installed recipes; ${coverage.filter((r) => r.status === "ASSET_REVIEW_REQUIRED").length} store/icon frames require separate artifact review.`,
    "",
    ...summary.scopeNotes.map((note) => `- ${note}`),
    "",
    "| Frame | Theme | Diff % | Result | Reason | Diff image |",
    "|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${cell(r.id)} | ${cell(r.theme)} | ${r.percent === undefined ? "n/a" : r.percent.toFixed(9)} | ${r.status} | ${cell(r.reason)} | ${cell(r.diff ?? "")} |`,
    ),
    "",
  ].join("\n"),
);
console.log(`\n${counts.pass} PASS, ${counts.fail} FAIL, ${counts.blocked} BLOCKED. Report: ${relative(REPO, join(OUT, "report.md"))}`);
process.exit(counts.fail > 0 || counts.blocked > 0 ? 1 : 0);
