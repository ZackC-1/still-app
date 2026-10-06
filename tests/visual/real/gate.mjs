// The V1 gate, unchanged, for real-extension captures: the design package's own compare.script
// decides the pixel difference, and a frame passes only when differing pixels * 200 <= total
// pixels (0.5%, unrounded). No masks, no cropping of differing pixels, no threshold changes.
// This mirrors compare() in tests/visual/run.mjs; keep the two identical.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
