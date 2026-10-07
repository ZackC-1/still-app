// Each surface gets a fresh process: Vite/WXT environment caches cannot cross profiles.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, SURFACES } from "./v3-profile.mjs";

const [surface, output] = process.argv.slice(2);
if (!Object.hasOwn(SURFACES, surface) || !output)
  throw new Error("Invalid QA build surface");
const packageDir = join(ROOT, "packages", SURFACES[surface]);
const require = createRequire(join(packageDir, "package.json"));
// This process's empty cwd isolates WXT's dotenv loader. envDir isolates Vite's loader too.
const envDir = process.cwd();
if (surface === "apple-webview") {
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  await build({
    root: packageDir,
    configFile: join(packageDir, "vite.config.ts"),
    mode: "production",
    envDir,
    build: { outDir: join(output, "artifact"), emptyOutDir: true },
  });
} else {
  execFileSync(
    process.execPath,
    [
      join(ROOT, "packages/core/scripts/gen-content-css.mjs"),
      "entrypoints/content",
    ],
    { cwd: packageDir, env: process.env, stdio: "inherit" },
  );
  const { build } = await import(pathToFileURL(require.resolve("wxt")).href);
  await build({
    root: packageDir,
    mode: "production",
    browser: surface,
    outDir: output,
    outDirTemplate: "artifact",
    vite: () => ({ envDir }),
  });
}
