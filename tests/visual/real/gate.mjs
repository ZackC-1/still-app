// The V1 gate, unchanged, for real-extension captures: the design package's own compare.script
// decides the pixel difference, and a frame passes only when differing pixels * 200 <= total
// pixels (0.5%, unrounded). No masks, no cropping of differing pixels, no threshold changes.
// This mirrors compare() in tests/visual/run.mjs; keep the two identical.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function pngSize(file) {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The verdict rule alone, so a test can pin it. */
export function withinGate(differing, total) {
  return differing * 200 <= total;
}

/**
 * @param {{ pkg: string, compareScript: string }} package_
 */
export function compare({ pkg, compareScript }, reference, implementation, diff) {
  const run = spawnSync(process.execPath, ["--input-type=module", "-", reference, implementation, diff], {
    input: readFileSync(compareScript),
    cwd: pkg,
    encoding: "utf8",
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  const counted = /([\d.]+)% of pixels differ \((\d+)\)/.exec(output);
  if (!counted) return { error: output || `compare exited ${run.status}`, scriptExit: run.status };
  const { width, height } = pngSize(reference);
  const differing = Number(counted[2]);
  return {
    scriptExit: run.status,
    printedPercent: counted[1],
    differing,
    total: width * height,
    percent: (100 * differing) / (width * height),
    passed: withinGate(differing, width * height),
  };
}

/**
 * The browser chrome drawn at the top of a reference (a tab strip), read as data from the frame map
 * (`referenceChrome`): `top` CSS px of the reference are the strip; `pageOffset` is how far lower
 * the reference lays the page out than the product draws it (defaults to `top`, a strip that pushes
 * the page down). All 0 when the reference has none.
 */
export function referenceChrome(id, mapFile = join(HERE, "frames.json")) {
  const data = JSON.parse(readFileSync(mapFile, "utf8")).frames.find((f) => f.id === id)?.referenceChrome;
  const top = data?.topCssPx ?? 0;
  return { top, pageOffset: data?.pageOffsetCssPx ?? top };
}

/**
 * Write a copy of a reference with its top `topCssPx` CSS px removed (the documented browser
 * chrome, which the product never draws). The package's own PNG is never touched; the copy is a
 * scratch file. The implementation is captured at the remaining height, so the gate still compares
 * every remaining pixel with no mask.
 */
export function cropReferenceTop(pkg, reference, out, topCssPx, scale = 2) {
  const { PNG } = createRequire(join(pkg, "package.json"))("pngjs");
  const source = PNG.sync.read(readFileSync(reference));
  const rows = Math.round(topCssPx * scale);
  const cropped = new PNG({ width: source.width, height: source.height - rows });
  source.data.copy(cropped.data, 0, rows * source.width * 4);
  writeFileSync(out, PNG.sync.write(cropped));
  return out;
}

/**
 * Whether a built extension has sign-in compiled in (a Supabase URL and anon key were supplied at
 * build time). The lane input STILL_VISUAL_SIGN_IN=1 or 0 overrides the build scan. The scan looks
 * for a literal anon key where an unconfigured build has `anonKey:void 0`.
 */
export function signInCompiledIn(extensionDir, env = process.env) {
  if (env.STILL_VISUAL_SIGN_IN === "1") return true;
  if (env.STILL_VISUAL_SIGN_IN === "0") return false;
  const background = join(extensionDir, "background.js");
  return existsSync(background) && /anonKey:\s*[`"'][^`"']+[`"']/.test(readFileSync(background, "utf8"));
}
