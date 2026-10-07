import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLineage, designInputs } from "../inputs.mjs";

// A failed test restarts Playwright's worker, so the output folder is cleaned once per run here, not
// in a beforeAll that would run again and delete the earlier frames and rows.
export default function globalSetup(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(here, "../../../..");
  const inputs = designInputs(repo);
  const build = buildLineage(repo, join(repo, "packages/ext-chromium/dist/firefox-mv3"));
  const out = resolve(
    process.env.STILL_VISUAL_FIREFOX_OUTPUT ?? join(here, ".output"),
  );
  rmSync(out, { recursive: true, force: true });
  for (const dir of ["impl", "diff", "rows"])
    mkdirSync(join(out, dir), { recursive: true });
  writeFileSync(join(out, "run-lineage.json"), JSON.stringify({ build, inputFiles: inputs.inputFiles }));
}
