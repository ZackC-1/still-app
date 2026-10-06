// Validates tests/visual/real/frames.json (the frame-to-tier map). Run: node --test tests/visual/real/frames.test.mjs
// The design package is private; the package-count check is skipped when it is absent (CI).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateFrames } from "./validate-frames.mjs";

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
