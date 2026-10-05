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
import { compare } from "../gate.mjs";
import { cases } from "./cases.mjs";

// T1 Firefox visual runner: the real built Firefox extension in stock Firefox, photographed with
// Firefox's own window snapshot at 2x (the popup as the real toolbar panel), compared with the design
// package's 2x reference by the package's own compare.script and the V1 gate, unchanged. See
// playwright.config.ts for how to run it. Skips cleanly when the private design package is absent.
//
// Output (gitignored): tests/visual/real/firefox/.output/{report.md,report.json,impl/*.png,diff/*.png}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const PKG = resolve(
  process.env.STILL_DESIGN_PACKAGE ??
    resolve(REPO, "build/v3/still-design-system-v3.2"),
);
const OUT = resolve(
  process.env.STILL_VISUAL_FIREFOX_OUTPUT ?? join(HERE, ".output"),
);
const COMPARE = join(PKG, "handoff/compare.script");
const REFERENCES = join(PKG, "handoff/reference");
const PACKAGE_COMPARE = { pkg: PKG, compareScript: COMPARE };

const present =
  existsSync(COMPARE) &&
  existsSync(join(PKG, "node_modules/pngjs")) &&
  existsSync(join(PKG, "node_modules/pixelmatch")) &&
  existsSync(join(FIREFOX_EXTENSION, "manifest.json"));

test.skip(
  !present,
  `SKIPPED: design package (STILL_DESIGN_PACKAGE) or the Firefox build is missing; nothing compared`,
);

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
const record = (row: Row) =>
  writeFileSync(join(OUT, "rows", `${row.id}.json`), JSON.stringify(row));

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
  const reference = join(REFERENCES, c.reference);
  const ref = pngSize(readFileSync(reference));
  const size = { width: ref.width / 2, height: Math.ceil(ref.height / 2) };
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
      png = await chrome.snapshotTab("first-run.html", size);
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
      png = await chrome.snapshotTab("first-run.html", size);
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
      await withShift(page);
      await new Promise((done) => setTimeout(done, 600));
      await chrome.frameTab("options.html", size);
      png = await chrome.snapshotTab("options.html", size);
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
      png = await chrome.snapshotTab("tiktok-blocked.html", size);
    } else {
      // The real toolbar popup. Its height is its own, so it is captured at its own size.
      await first.close();
      if (c.recipe === "popup-still-off")
        await setSwitch(firefox, "Still", false);
      await chrome.openPopup();
      const shot = await chrome.snapshotPopup();
      png = shot.png;
    }
    writeFileSync(file, png);
    return pngSize(png);
  } finally {
    await firefox.stop();
  }
}

test.afterAll(() => {
  if (!present) return;
  // Rebuilt from the per-frame rows, so a worker restart after a failure loses nothing.
  const rows = cases
    .map((c) => join(OUT, "rows", `${c.id}.json`))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, "utf8")) as Row);
  if (rows.length === 0) return;
  const gated = rows.filter((r) => r.mode === "gated");
  writeFileSync(
    join(OUT, "report.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), designPackage: PKG, rows }, null, 2)}\n`,
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
      test.skip(true, c.reason);
    }
    const reference = join(REFERENCES, c.reference);
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
    const outcome = compare(PACKAGE_COMPARE, reference, impl, diff);
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
      reason: status === "FAIL" ? (c as { causes?: string }).causes : undefined,
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
  expect(cleanResult.passed, "a repeat capture is the same picture").toBe(true);
  expect(shiftedResult.passed, "a 2px shift must fail the gate").toBe(false);
});
