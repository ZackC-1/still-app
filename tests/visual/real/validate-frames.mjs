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
