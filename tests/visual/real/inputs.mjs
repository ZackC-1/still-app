import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

export const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Validate inputs before launching a browser. The project label v3.1 uses design version 3.0.1. */
export function designInputs(repo, env = process.env) {
  const pkg = resolve(env.STILL_DESIGN_PACKAGE ?? join(repo, "docs/design/Still v3.1 redesign/source"));
  const references = resolve(env.STILL_VISUAL_REFERENCE_DIR ?? join(pkg, "handoff/reference"));
  const compareScript = join(pkg, "handoff/compare.script");
  const inventoryFile = join(references, "render-inventory.json");
  if (!existsSync(compareScript) || !existsSync(inventoryFile))
    throw new Error(`FAIL: comparator or reference inventory missing at ${pkg} / ${references}. Set STILL_DESIGN_PACKAGE and STILL_VISUAL_REFERENCE_DIR. No frames compared.`);
  const inventoryBytes = readFileSync(inventoryFile);
  const compareBytes = readFileSync(compareScript);
  let inventory;
  try { inventory = JSON.parse(inventoryBytes.toString("utf8")); }
  catch { throw new Error(`FAIL: invalid reference inventory JSON at ${inventoryFile}. No frames compared.`); }
  if (inventory?.design_version !== "3.0.1" || inventory.device_scale_factor !== 2 || !Array.isArray(inventory.inventory))
    throw new Error(`FAIL: reference inventory must identify latest design version 3.0.1 at device scale 2. No frames compared.`);
  const tokensFile = join(pkg, "tokens/tokens.json");
  const spacingFile = join(pkg, "tokens/spacing.css");
  let packageVersion;
  let tokensBytes, spacingBytes;
  try {
    tokensBytes = readFileSync(tokensFile);
    spacingBytes = readFileSync(spacingFile);
    packageVersion = JSON.parse(tokensBytes.toString("utf8"))?.version;
    const spacing = spacingBytes.toString("utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const declarations = [...spacing.matchAll(/--ds-version\s*:\s*(['"])([^'"]+)\1\s*;/g)];
    if (packageVersion !== "3.0.1" || [...spacing.matchAll(/--ds-version\s*:/g)].length !== 1 ||
        declarations.length !== 1 || declarations[0][2] !== packageVersion) throw new Error("stale or ambiguous tokens");
  } catch { throw new Error("FAIL: selected source tokens and spacing must identify latest design version 3.0.1 and agree with references. No frames compared."); }
  const frames = inventory.inventory.flatMap((page) => {
    if (typeof page?.name !== "string" || !Array.isArray(page.frames)) throw new Error("FAIL: invalid reference page inventory. No frames compared.");
    return page.frames.map((frame) => ({ ...frame, file: `${slug(page.name)}/${frame.output}` }));
  });
  if (!frames.length || new Set(frames.map((f) => f.file)).size !== frames.length)
    throw new Error("FAIL: empty or duplicate reference inventory. No frames compared.");
  for (const frame of frames) {
    const file = frame.file;
    if (typeof frame.output !== "string" || !/^[^/\\]+\.png$/.test(frame.output) || frame.output === "..png" ||
        !existsSync(join(references, file)) || ![frame.bounding_box?.width, frame.bounding_box?.height].every((n) => Number.isFinite(n) && n > 0) ||
        !["light", "dark"].includes(frame.render?.theme))
      throw new Error(`FAIL: invalid or missing reference frame ${file}. No frames compared.`);
  }
  const tooling = existsSync(join(pkg, "handoff/package.json")) ? join(pkg, "handoff") : pkg;
  const require = createRequire(join(tooling, "package.json"));
  for (const dep of ["pngjs", "pixelmatch"]) {
    try { require.resolve(dep); }
    catch { throw new Error(`FAIL: the design comparator needs ${dep}; install comparator dependencies in ${tooling}. No frames compared.`); }
  }
  const { PNG } = require("pngjs");
  const referencePngs = frames.map((frame) => {
    const path = join(references, frame.file);
    const bytes = readFileSync(path);
    let image;
    try { image = PNG.sync.read(bytes); }
    catch { throw new Error(`FAIL: invalid reference PNG ${path}. No frames compared.`); }
    const box = frame.bounding_box;
    // Playwright element screenshots enclose fractional CSS coordinates before multiplying
    // by device scale. This also accounts for a fractional origin, not just fractional size.
    if (![box.x, box.y].every(Number.isFinite)) throw new Error(`FAIL: invalid reference PNG bounding box ${path}. No frames compared.`);
    const width = (Math.ceil(box.x + box.width) - Math.floor(box.x)) * 2;
    const height = (Math.ceil(box.y + box.height) - Math.floor(box.y)) * 2;
    if (image.width !== width || image.height !== height)
      throw new Error(`FAIL: reference PNG ${path} dimensions ${image.width}x${image.height} must be ${width}x${height} at 2x. No frames compared.`);
    return { file: frame.file, path, sha256: digest(bytes), pixelWidth: image.width, pixelHeight: image.height };
  });
  const inputFiles = [[compareScript, compareBytes], [inventoryFile, inventoryBytes], [tokensFile, tokensBytes], [spacingFile, spacingBytes]]
    .map(([path, bytes]) => ({ path, sha256: digest(bytes) })).concat(referencePngs.map(({ path, sha256 }) => ({ path, sha256 })));
  assertReferencesStable({ inputFiles });
  return { pkg, references, compareScript, tooling, inventory, inventoryFile, frames,
    inputFiles,
    lineage: { designPackage: pkg, referenceDirectory: references, referenceInventory: inventoryFile,
      designVersion: inventory.design_version, sourcePackageVersion: packageVersion,
      tokensSha256: digest(tokensBytes), spacingSha256: digest(spacingBytes),
      comparatorSha256: digest(compareBytes), inventorySha256: digest(inventoryBytes), referencePngs } };
}

export function assertReferencesStable(inputs) {
  for (const file of inputs.inputFiles) {
    if (!existsSync(file.path) || digest(readFileSync(file.path)) !== file.sha256)
      throw new Error(`FAIL: reference inputs changed during capture: ${file.path}`);
  }
}

/** Whole-built-directory digest distinguishes an actual artifact from a source-only check. */
export function buildLineage(repo, directory) {
  const files = [];
  const visit = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), name + "/");
      else if (entry.isFile()) files.push([name, digest(readFileSync(join(dir, entry.name)))]);
      else throw new Error(`FAIL: unsupported entry in measured build: ${name}`);
    }
  };
  visit(directory);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
  const changes = spawnSync("git", ["diff", "HEAD", "--binary"], { cwd: repo });
  const manifestFile = join(dirname(realpathSync(directory)), "artifact-manifest.json");
  let qaProfile = null;
  let generatedBrowserFiles = files.filter(([name]) => /^_metadata\/generated_indexed_rulesets\/_ruleset\d+$/.test(name));
  if (existsSync(manifestFile)) {
    const manifestBytes = readFileSync(manifestFile);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const recorded = manifest.artifacts?.files?.map((file) => [file.path, file.sha256]);
    // Chromium compiles packaged declarative rules into this directory on installation.
    // Keep its bytes in the measured directory digest; do not mistake them for shipped files.
    generatedBrowserFiles = files.filter(([name]) => /^_metadata\/generated_indexed_rulesets\/_ruleset\d+$/.test(name) && !recorded?.some(([path]) => path === name));
    if (!Array.isArray(recorded) || new Set(recorded.map(([path]) => path)).size !== recorded.length ||
        recorded.some(([path, hash]) => typeof path !== "string" || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) ||
        recorded.length + generatedBrowserFiles.length !== files.length ||
        recorded.some(([name, sha]) => !files.some(([actualName, actualSha]) => name === actualName && sha === actualSha)))
      throw new Error("FAIL: QA artifact manifest does not describe the actual measured build");
    // Include only source/profile facts, never backend inputs or private configuration.
    qaProfile = { profile: manifest.profile, surface: manifest.surface, sourceSha256: manifest.sourceSha256, revision: manifest.revision ?? null, dirty: manifest.dirty ?? null,
      runtime: manifest.runtime, manifestSha256: digest(manifestBytes) };
  }
  // Ordinary unpacked builds have no attributable build source without a receipt.
  const shippedFiles = files.filter(([name]) => !/^_metadata\/generated_indexed_rulesets\/_ruleset\d+$/.test(name));
  return { directory, files: files.length, sha256: digest(JSON.stringify(files)), sourceCommit: qaProfile?.revision ?? null, sourceDirty: qaProfile?.dirty ?? null,
    captureCheckout: { sourceCommit: head.status === 0 ? head.stdout.trim() : null, trackedSourceDiffSha256: changes.status === 0 ? digest(changes.stdout) : null },
    shippedFiles, shippedSha256: digest(JSON.stringify(shippedFiles)), qaProfile, generatedBrowserFiles };
}

export function assertBuildStable(repo, before) {
  const after = buildLineage(repo, before.directory);
  if (before.shippedSha256 !== after.shippedSha256 || before.qaProfile?.manifestSha256 !== after.qaProfile?.manifestSha256)
    throw new Error(`FAIL: shipped artifact changed during capture: ${before.directory}`);
  return after;
}

/** Every latest DOM frame remains accounted for, including store assets outside a browser lane. */
export function coverageLedger(frames, cases, results) {
  const mapped = new Map(cases.map((c) => [c.reference, c]));
  const measured = new Map(results.map((r) => [r.id, r]));
  return frames.map((frame) => {
    const c = mapped.get(frame.file);
    const result = c && measured.get(c.id);
    const asset = frame.file.startsWith("d41-d43-d45-store-assets-and-icons/");
    return { reference: frame.file, caption: frame.caption, id: c?.id ?? null,
      status: result?.status ?? (c ? "NOT_RUN" : asset ? "ASSET_REVIEW_REQUIRED" : "UNMAPPED"),
      reason: result?.reason ?? (c ? "not selected in this run" : asset ? "store/icon artifact review is separate from installed app screens" : "no installed-host recipe for this frame") };
  });
}
