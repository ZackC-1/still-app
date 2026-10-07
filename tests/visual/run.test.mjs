import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, "../../docs/design/Still v3.1 redesign/source");

// These subprocesses exercise input rejection, before dependencies or a browser are needed.
// Use the actual supplied comparator and token files; real pixel checks use --self-test.
function runWithSource(change) {
  const dir = mkdtempSync(
    join(tmpdir(), "Still v3.1 redesign-source-lineage-"),
  );
  try {
    const source = join(dir, "source");
    const refs = join(dir, "reference");
    mkdirSync(join(source, "tokens"), { recursive: true });
    mkdirSync(join(source, "handoff"));
    mkdirSync(refs);
    for (const file of [
      "tokens/tokens.json",
      "tokens/spacing.css",
      "handoff/compare.script",
      "handoff/package.json",
    ]) {
      copyFileSync(join(SOURCE, file), join(source, file));
    }
    writeFileSync(
      join(refs, "render-inventory.json"),
      JSON.stringify({ design_version: "3.0.1", inventory: [] }),
    );
    change(source);
    const env = {
      ...process.env,
      STILL_DESIGN_PACKAGE: source,
      STILL_VISUAL_REFERENCE_DIR: refs,
      STILL_VISUAL_OUTPUT: join(dir, "output"),
    };
    delete env.NODE_PATH;
    return spawnSync(process.execPath, [join(HERE, "run.mjs"), "--self-test"], {
      env,
      encoding: "utf8",
      timeout: 10000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const changeTokens = (source, change) => {
  const path = join(source, "tokens/tokens.json");
  const tokens = JSON.parse(readFileSync(path, "utf8"));
  change(tokens);
  writeFileSync(path, JSON.stringify(tokens));
};
const changeSpacing = (source, change) => {
  const path = join(source, "tokens/spacing.css");
  writeFileSync(path, change(readFileSync(path, "utf8")));
};

const invalidSources = [
  ["older token version", (s) => changeTokens(s, (t) => (t.version = "3.0.0"))],
  ["missing token version", (s) => changeTokens(s, (t) => delete t.version)],
  [
    "malformed tokens",
    (s) => writeFileSync(join(s, "tokens/tokens.json"), "{"),
  ],
  ["missing token file", (s) => unlinkSync(join(s, "tokens/tokens.json"))],
  [
    "older CSS version",
    (s) => changeSpacing(s, (c) => c.replace('"3.0.1"', '"3.0.0"')),
  ],
  [
    "missing CSS version",
    (s) => changeSpacing(s, (c) => c.replace('--ds-version: "3.0.1";', "")),
  ],
  [
    "malformed CSS version",
    (s) =>
      changeSpacing(s, (c) =>
        c.replace('--ds-version: "3.0.1";', "--ds-version: 3.0.1;"),
      ),
  ],
  [
    "ambiguous CSS version",
    (s) => changeSpacing(s, (c) => `${c}\n:root { --ds-version: "3.0.0"; }`),
  ],
  [
    "malformed duplicate CSS version",
    (s) => changeSpacing(s, (c) => `${c}\n:root { --ds-version: 3.0.0; }`),
  ],
];

for (const [name, change] of invalidSources) {
  test(`rejects ${name} paired with latest references before rendering`, () => {
    const run = runWithSource(change);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /FAIL:.*design source/);
    assert.match(run.stderr, /No frames compared/);
  });
}

test("latest source and references proceed to comparator dependency validation", () => {
  const run = runWithSource(() => {});
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /needs its own pngjs/);
});
