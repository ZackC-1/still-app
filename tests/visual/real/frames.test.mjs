// Validates tests/visual/real/frames.json (the frame-to-tier map). Run: node --test tests/visual/real/frames.test.mjs
// The design package is private; the package-count check is skipped when it is absent (CI).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { signInCompiledIn } from "./gate.mjs";
import { cases as chromeCases } from "./cases.mjs";
import { cases as firefoxCases } from "./firefox/cases.mjs";
import { caseProblems, validateFrames } from "./validate-frames.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const PKG = resolve(
  process.env.STILL_DESIGN_PACKAGE ?? join(REPO, "build/v3/still-design-system-v3.2"),
);
const REFERENCES = join(PKG, "handoff/reference");
const map = JSON.parse(readFileSync(join(HERE, "frames.json"), "utf8"));
const clone = () => structuredClone(map);

test("frames.json is well formed", () => {
  assert.deepEqual(validateFrames(map), []);
});

test("validator rejects a missing tier, missing recipe key, duplicate id and wrong count", () => {
  const noTier = clone();
  delete noTier.frames[0].tier;
  assert.match(validateFrames(noTier).join("\n"), /missing or unknown tier/);

  const noRecipe = clone();
  noRecipe.frames[1].recipes = {};
  assert.match(validateFrames(noRecipe).join("\n"), /missing recipe key/);

  const dup = clone();
  dup.frames[2].id = dup.frames[3].id;
  assert.match(validateFrames(dup).join("\n"), /duplicate id/);

  const short = clone();
  short.frames.pop();
  assert.match(validateFrames(short).join("\n"), /count/);
});

test(
  "frame count and file names match the design package",
  { skip: existsSync(join(REFERENCES, "render-inventory.json")) ? false : "design package not present" },
  () => {
    const onDisk = readdirSync(REFERENCES, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) =>
        readdirSync(join(REFERENCES, d.name))
          .filter((n) => n.endsWith(".png"))
          .map((n) => `${d.name}/${n}`),
      )
      .sort();
    assert.equal(map.frames.length, onDisk.length);
    assert.deepEqual(map.frames.map((f) => f.file).sort(), onDisk);
  },
);

test("the Chrome and Firefox T1 case lists agree with the frame map", () => {
  assert.deepEqual(caseProblems(chromeCases, map), []);
  assert.deepEqual(caseProblems(firefoxCases, map), []);
});

test("the case check rejects a wrong reference, theme, id and tier", () => {
  const first = chromeCases[0];
  assert.match(caseProblems([{ ...first, reference: "x/y.png" }], map).join("\n"), /reference/);
  assert.match(caseProblems([{ ...first, theme: first.theme === "dark" ? "light" : "dark" }], map).join("\n"), /theme/);
  assert.match(caseProblems([{ ...first, id: "nope-99" }], map).join("\n"), /not in frames.json/);
  assert.match(caseProblems([first], map, "T3").join("\n"), /does not list T3/);
});

test("referenceChrome offsets are positive numbers, and the three tab-strip references carry one", () => {
  const bad = clone();
  bad.frames.find((f) => f.id === "d14-01").referenceChrome = { topCssPx: 0 };
  assert.match(validateFrames(bad).join("\n"), /referenceChrome\.topCssPx/);
  for (const id of ["d14-01", "d03-01", "d03-14"])
    assert.equal(map.frames.find((f) => f.id === id).referenceChrome.topCssPx, 37, id);
  const tooBig = clone();
  tooBig.frames.find((f) => f.id === "d03-01").referenceChrome.pageOffsetCssPx = 50;
  assert.match(validateFrames(tooBig).join("\n"), /pageOffsetCssPx/);
});

test("sign-in gating reads the build, with STILL_VISUAL_SIGN_IN as an override", () => {
  const build = (background) => {
    const dir = mkdtempSync(join(tmpdir(), "still-build-"));
    writeFileSync(join(dir, "background.js"), background);
    return dir;
  };
  const configured = build("o({prod:!0,url:`https://x.invalid`,anonKey:`public-key`,area:a})");
  const plain = build("o({prod:!0,url:void 0,anonKey:void 0,area:a});f({anonKey:e.anonKey})");
  assert.equal(signInCompiledIn(configured, {}), true);
  assert.equal(signInCompiledIn(plain, {}), false);
  assert.equal(signInCompiledIn(join(tmpdir(), "no-such-build"), {}), false);
  assert.equal(signInCompiledIn(plain, { STILL_VISUAL_SIGN_IN: "1" }), true);
  assert.equal(signInCompiledIn(configured, { STILL_VISUAL_SIGN_IN: "0" }), false);
});
