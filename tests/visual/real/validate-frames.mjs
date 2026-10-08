// Pure validation of tests/visual/real/frames.json, shared by the test and any future runner.
export const TIERS = ["T0", "T1", "T2", "T3", "X"];

/** Returns a list of problems; an empty list means the frame map is well formed. */
export function validateFrames(map) {
  const problems = [];
  if (!map || !Array.isArray(map.frames)) return ["frames must be an array"];
  const ids = new Set();
  const files = new Set();
  const recipes = new Set();
  for (const f of map.frames) {
    const at = `frame ${f?.id ?? "(no id)"}`;
    if (typeof f?.id !== "string" || f.id === "") problems.push(`${at}: missing id`);
    else if (ids.has(f.id)) problems.push(`${at}: duplicate id`);
    else ids.add(f.id);
    if (typeof f?.file !== "string" || !f.file.endsWith(".png"))
      problems.push(`${at}: missing png file name`);
    else if (files.has(f.file)) problems.push(`${at}: duplicate file`);
    else files.add(f.file);
    if (!TIERS.includes(f?.tier)) problems.push(`${at}: missing or unknown tier`);
    if (!Array.isArray(f?.tiers) || f.tiers.length === 0 || f.tiers.at(-1) !== f.tier)
      problems.push(`${at}: tiers must be non-empty and end with tier`);
    if (!TIERS.includes(f?.tierToday)) problems.push(`${at}: missing or unknown tierToday`);
    if (f?.referenceChrome !== undefined) {
      const top = f.referenceChrome?.topCssPx;
      if (typeof top !== "number" || !(top > 0))
        problems.push(`${at}: referenceChrome.topCssPx must be a positive number`);
      const offset = f.referenceChrome?.pageOffsetCssPx;
      if (offset !== undefined && !(typeof offset === "number" && offset >= 0 && offset <= top))
        problems.push(`${at}: referenceChrome.pageOffsetCssPx must be between 0 and topCssPx`);
    }
    const rec = f?.recipes;
    if (!rec || typeof rec !== "object" || Object.keys(rec).length === 0)
      problems.push(`${at}: missing recipe key`);
    else
      for (const t of f.tiers ?? []) {
        const key = rec[t];
        if (typeof key !== "string" || key === "") problems.push(`${at}: no recipe key for ${t}`);
        else if (recipes.has(key) && !key.startsWith("none.")) problems.push(`${at}: duplicate recipe key ${key}`);
        else recipes.add(key);
      }
  }
  if (map.count !== map.frames.length)
    problems.push(`count ${map.count} does not match ${map.frames.length} frames`);
  return problems;
}

/**
 * Problems between a lane's case list and the frame map. Every case must name a frame in the map,
 * with the same reference file and theme, and the frame must list the lane's tier. `tier` is "T1"
 * for the Chrome and Firefox lanes.
 */
export function caseProblems(cases, map, tier = "T1") {
  const byId = new Map(map.frames.map((f) => [f.id, f]));
  const problems = [];
  for (const c of cases) {
    const frame = byId.get(c.id);
    if (!frame) problems.push(`${c.id}: not in frames.json`);
    else {
      if (frame.file !== c.reference) problems.push(`${c.id}: reference ${c.reference} but frames.json has ${frame.file}`);
      if (frame.theme !== c.theme) problems.push(`${c.id}: theme ${c.theme} but frames.json has ${frame.theme}`);
      if (!frame.tiers.includes(tier)) problems.push(`${c.id}: frames.json does not list ${tier} for this frame`);
    }
  }
  return problems;
}

/** The committed coverage map must describe the actual selected latest DOM inventory. */
export function inventoryProblems(map, frames) {
  const expected = new Set(frames.map((f) => f.file));
  const actual = new Set(map.frames.map((f) => f.file));
  return [
    ...(map.designVersion !== "3.0.1" ? ["frame map must identify latest design version 3.0.1"] : []),
    ...frames.filter((f) => !actual.has(f.file)).map((f) => `reference not mapped: ${f.file}`),
    ...map.frames.filter((f) => !expected.has(f.file)).map((f) => `stale map reference: ${f.file}`),
  ];
}
