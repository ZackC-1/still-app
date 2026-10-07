import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FirefoxChrome, pngSize } from "../../../firefox/_qa-capture.js";
import { firstRunTab, startFresh } from "../../../firefox/_qa-session.js";
import {
  FIREFOX_EXTENSION,
  type StillFirefox,
  type Tab,
} from "../../../firefox/_session.js";
import { designInputs, buildLineage, assertBuildStable, assertReferencesStable, coverageLedger } from "../inputs.mjs";
import { compare, cropReferenceTop, referenceChrome } from "../gate.mjs";
import { caseProblems, inventoryProblems } from "../validate-frames.mjs";
import { cases } from "./cases.mjs";

// T1 Firefox visual runner: the real built Firefox extension in stock Firefox, photographed with
// Firefox's own window snapshot at 2x (the popup as the real toolbar panel), compared with the design
// package's 2x reference by the package's own compare.script and the V1 gate, unchanged. See
// playwright.config.ts for how to run it. Missing or stale design inputs fail before browser launch.
//
// Output (gitignored): tests/visual/real/firefox/.output/{report.md,report.json,impl/*.png,diff/*.png}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const inputs = designInputs(REPO);
const { references: REFERENCES, compareScript: COMPARE, tooling: TOOLING } = inputs;
const OUT = resolve(
  process.env.STILL_VISUAL_FIREFOX_OUTPUT ?? join(HERE, ".output"),
);
const PACKAGE_COMPARE = { pkg: TOOLING, compareScript: COMPARE };
const FRAME_MAP = join(HERE, "..", "frames.json");

// Every case must agree with the frame map (id, reference file, theme, tier).
const frameMap = JSON.parse(readFileSync(FRAME_MAP, "utf8"));
const mapProblems = [...caseProblems(cases, frameMap), ...inventoryProblems(frameMap, inputs.frames)];
if (mapProblems.length > 0)
  throw new Error(`Firefox cases disagree with frames.json:\n  ${mapProblems.join("\n  ")}`);

if (!existsSync(join(FIREFOX_EXTENSION, "manifest.json"))) throw new Error("FAIL: the built Firefox extension is missing; no frames compared");
let lineage = { ...inputs.lineage, build: buildLineage(REPO, FIREFOX_EXTENSION) };
let runInputs = inputs;
// Global setup owns one baseline for the entire run; replacement workers cannot adopt a
// rebuilt artifact and attribute persisted screenshots from an earlier worker to it.
test.beforeAll(() => {
  const pinned = JSON.parse(readFileSync(join(OUT, "run-lineage.json"), "utf8"));
  runInputs = { ...inputs, inputFiles: pinned.inputFiles };
  lineage = { ...inputs.lineage, build: pinned.build };
  assertReferencesStable(inputs);
  assertReferencesStable(runInputs);
  assertBuildStable(REPO, lineage.build);
});
const stable = () => { assertReferencesStable(runInputs); return assertBuildStable(REPO, lineage.build); };
type Case = (typeof cases)[number];
type Row = {
  id: string;
  mode: string;
  status: string;
  reason?: string;
  percent?: number;
  differing?: number;
  size?: string;
  reference?: string;
  impl?: string;
};
const record = (row: Row) => {
  mkdirSync(join(OUT, "rows"), { recursive: true });
  writeFileSync(join(OUT, "rows", `${row.id}.json`), JSON.stringify({ ...row, lineage }));
};

const setSwitch = async (firefox: StillFirefox, label: string, on: boolean) => {
  const popup = await firefox.openExtensionPage("popup.html");
  const sel = `button[role=switch][aria-label=${JSON.stringify(label)}]`;
  await popup.waitFor(
    `${label} switch`,
    () => popup.count(sel),
    (n) => n === 1,
  );
  const read = () =>
    popup.evaluate<string>(
      `document.querySelector(${JSON.stringify(sel)}).getAttribute("aria-checked")`,
    );
  if ((await read()) !== String(on))
    await popup.evaluate(
      `document.querySelector(${JSON.stringify(sel)}).click()`,
    );
  await popup.waitFor("settled", read, (v) => v === String(on));
  await popup.close();
};

/** Capture one case to `file` at the reference's CSS size; returns the PNG size in pixels. */
async function capture(
  c: Case,
  file: string,
  { shift = 0 } = {},
): Promise<{ width: number; height: number }> {
  stable();
  const reference = join(REFERENCES, c.reference);
  const ref = pngSize(readFileSync(reference));
  // A reference with browser chrome (a tab strip) is photographed without it; see frames.json.
  const { top, pageOffset } = referenceChrome(c.id, FRAME_MAP);
  const size = { width: ref.width / 2, height: Math.ceil(ref.height / 2) - pageOffset };
  const snap = { width: size.width, height: Math.ceil(ref.height / 2) - top };
  const snapY = top - pageOffset;
  let cardY = 0;
  const firefox = await startFresh((url) =>
    url.hostname.endsWith("tiktok.com") ? "<h1>fixture</h1>" : null,
  );
  try {
    const chrome = await FirefoxChrome.attach(firefox.bidi);
    await chrome.setColorScheme(c.theme as "light" | "dark");
    const first = await firstRunTab(firefox);
    let png: Buffer;
    const withShift = async (tab: Tab) => {
      if (shift)
        await tab.evaluate(
          `(document.documentElement.style.transform = "translateX(${shift}px)", true)`,
        );
    };
    if (c.recipe === "firstrun-fresh") {
      await first.waitFor(
        "the page",
        () => first.count("h1"),
        (n) => n === 1,
      );
      await withShift(first);
      await chrome.frameTab("first-run.html", size);
      png = await chrome.snapshotTab("first-run.html", snap, 2, snapY);
    } else if (c.recipe === "firstrun-permission-needed") {
      await first.close();
      await (
        await firefox.openExtensionPage("options.html")
      ).evaluate(
        `browser.permissions.remove({ origins: ["*://*.youtube.com/*", "*://*.instagram.com/*", "*://*.facebook.com/*", "*://*.tiktok.com/*"] })`,
      );
      const page = await firefox.openExtensionPage("first-run.html");
      await page.waitFor(
        "the permission step",
        () => page.evaluate<string>("document.body.innerText"),
        (t) => t.includes("One step to finish setup"),
      );
      await withShift(page);
      await chrome.frameTab("first-run.html", size);
      png = await chrome.snapshotTab("first-run.html", snap, 2, snapY);
    } else if (
      c.recipe === "options-fresh" ||
      c.recipe === "options-still-off"
    ) {
      await first.close();
      if (c.recipe === "options-still-off")
        await setSwitch(firefox, "Still", false);
      const page = await firefox.openExtensionPage("options.html");
      await page.waitFor(
        "the switches",
        () => page.count("button[role=switch]"),
        (n) => n >= 5,
      );
      // The references show the YouTube section open; d03-10 is a photograph of that card.
      await page.evaluate(`document.querySelector("button.expander").click()`);
      await withShift(page);
      await new Promise((done) => setTimeout(done, 600));
      await chrome.frameTab("options.html", size);
      // d03-10 is the open YouTube card with 12 CSS px around it: snapshot from there down the page.
      if (c.id === "d03-10")
        cardY = await page.evaluate<number>(
          `Math.round(Math.max(0, window.scrollY + document.querySelector(".site-section").getBoundingClientRect().top - 12))`,
        );
      png = await chrome.snapshotTab("options.html", snap, 2, snapY + cardY);
    } else if (c.recipe === "tiktok-blocked") {
      await first.close();
      const tab = await firefox.openTab("https://www.tiktok.com/foryou");
      await tab.waitFor(
        "the blocked page",
        () => tab.url().catch(() => ""),
        (u) => /tiktok-blocked\.html/.test(u),
      );
      await tab.waitFor(
        "heading",
        () =>
          tab
            .evaluate<string>("document.querySelector('h1')?.textContent ?? ''")
            .catch(() => ""),
        (t) => t === "TikTok stays closed.",
      );
      await new Promise((done) => setTimeout(done, 600));
      await chrome.frameTab("tiktok-blocked.html", size);
      png = await chrome.snapshotTab("tiktok-blocked.html", snap, 2, snapY);
    } else {
      // The real toolbar popup. Its height is its own, so it is captured at its own size.
      await first.close();
      if (c.recipe === "popup-still-off")
        await setSwitch(firefox, "Still", false);
      await chrome.openPopup();
      const shot = await chrome.snapshotPopup();
      png = shot.png;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png);
    return pngSize(png);
  } finally {
    await firefox.stop();
    stable();
  }
}

test.afterAll(() => {
  const buildAfterCapture = stable();
  // Rebuilt from the per-frame rows, so a worker restart after a failure loses nothing.
  const rows = cases
    .map((c) => join(OUT, "rows", `${c.id}.json`))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, "utf8")) as Row);
  if (rows.length === 0) return;
  const gated = rows.filter((r) => r.mode === "gated");
  writeFileSync(
    join(OUT, "report.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), ...lineage, buildAfterCapture, coverage: coverageLedger(inputs.frames, cases, rows), rows }, null, 2)}\n`,
  );
  const cell = (v: unknown) =>
    String(v ?? "")
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ");
  writeFileSync(
    join(OUT, "report.md"),
    [
      "# T1 Firefox visual comparison",
      "",
      `Gated frames: ${gated.filter((r) => r.status === "PASS").length} PASS, ${gated.filter((r) => r.status === "FAIL").length} FAIL. INFO frames are Chrome references shown against the Firefox build and never count. BLOCKED frames cannot be reached.`,
      "",
      "| Frame | Kind | Result | Diff % | Size (px) | Reason |",
      "|---|---|---|---|---|---|",
      ...rows.map(
        (r) =>
          `| ${r.id} | ${r.mode} | ${r.status} | ${r.percent === undefined ? "n/a" : r.percent.toFixed(9)} | ${cell(r.size)} | ${cell(r.reason)} |`,
      ),
      "",
    ].join("\n"),
  );
});

for (const c of cases) {
  test(`${c.id} (${c.mode})`, async () => {
    if (c.mode === "blocked") {
      record({
        id: c.id,
        mode: c.mode,
        status: "BLOCKED",
        reason: c.reason,
        reference: c.reference,
      });
      throw new Error(`BLOCKED: ${c.reason}`);
    }
    mkdirSync(join(OUT, "impl"), { recursive: true });
    const original = join(REFERENCES, c.reference);
    const { top } = referenceChrome(c.id, FRAME_MAP);
    const reference = top
      ? cropReferenceTop(TOOLING, original, join(OUT, "impl", `${c.id}.reference.png`), top)
      : original;
    mkdirSync(join(OUT, "impl"), { recursive: true });
    const impl = join(OUT, "impl", `${c.id}.png`);
    const diff = join(OUT, "diff", `${c.id}.png`);
    const got = await capture(c, impl);
    const want = pngSize(readFileSync(reference));
    const size = `${got.width}x${got.height} (reference ${want.width}x${want.height})`;
    if (got.width !== want.width || got.height !== want.height) {
      // A size mismatch is a finding, not a pass: the gate compares same-size images only.
      record({
        id: c.id,
        mode: c.mode,
        status: c.mode === "gated" ? "FAIL" : "SIZE-MISMATCH",
        reason: "captured size differs from the reference",
        size,
      });
      if (c.mode === "gated") expect(size).toBe("same size");
      return;
    }
    stable();
    const outcome = compare(PACKAGE_COMPARE, reference, impl, diff);
    stable();
    if (outcome.error) {
      record({
        id: c.id,
        mode: c.mode,
        status: "FAIL",
        reason: outcome.error,
        size,
      });
      throw new Error(outcome.error);
    }
    const status =
      c.mode === "gated"
        ? outcome.passed
          ? "PASS"
          : "FAIL"
        : outcome.passed
          ? "INFO-within-gate"
          : "INFO-above-gate";
    record({
      id: c.id,
      mode: c.mode,
      status,
      percent: outcome.percent,
      differing: outcome.differing,
      size,
      reference: c.reference,
      impl: relative(REPO, impl),
    });
    if (c.mode === "gated")
      expect(
        outcome.passed,
        `${c.id}: ${outcome.percent.toFixed(9)}% of pixels differ`,
      ).toBe(true);
  });
}

test("self-test: an identical Firefox render passes, a 2px-shifted render fails the 0.5% gate", async () => {
  const c = cases.find((x) => x.id === "d14-03")!;
  const base = join(OUT, "self-test");
  mkdirSync(join(base, "x"), { recursive: true });
  // The reference is the runner's own clean capture (the package's references are never touched).
  const own = join(base, "own-reference.png");
  await capture(c, own);
  const clean = join(base, "clean.png");
  await capture(c, clean);
  const shifted = join(base, "shifted.png");
  await capture(c, shifted, { shift: 2 });
  const cleanResult = compare(
    PACKAGE_COMPARE,
    own,
    clean,
    join(base, "clean-diff.png"),
  );
  const shiftedResult = compare(
    PACKAGE_COMPARE,
    own,
    shifted,
    join(base, "shifted-diff.png"),
  );
  console.log(
    `self-test clean ${cleanResult.percent?.toFixed(6)}%  shifted ${shiftedResult.percent?.toFixed(6)}%`,
  );
  stable();
  expect(cleanResult.passed, "a repeat capture is the same picture").toBe(true);
  expect(shiftedResult.passed, "a 2px shift must fail the gate").toBe(false);
});
