// Reference rehearsal only; never uploads or claims operational access.
// node render-assets.mjs --id cws-1 --mode comparison|export
//   --design-root /path/to/approved/package --output-dir /private/tmp/owned-empty-dir
import {
  readFile,
  writeFile,
  mkdir,
  realpath,
  stat,
  symlink,
  readdir,
  chmod,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../../../..");
const inside = (parent, child) => child.startsWith(parent + sep);

async function main() {
  const options = new Map();
  const args = process.argv.slice(2);
  const names = new Set(["--id", "--mode", "--design-root", "--output-dir"]);
  for (let index = 0; index < args.length; index += 2) {
    if (
      !names.has(args[index]) ||
      options.has(args[index]) ||
      !args[index + 1]
    ) {
      throw new Error("Supply each known option exactly once with a value.");
    }
    options.set(args[index], args[index + 1]);
  }
  if (options.size !== names.size)
    throw new Error("All four options are required.");
  const manifest = JSON.parse(
    await readFile(join(here, "assets.json"), "utf8"),
  );
  const frame = manifest.frames.find((item) => item.id === options.get("--id"));
  if (!frame) throw new Error(`Unknown asset ID: ${options.get("--id")}`);
  const mode = options.get("--mode");
  if (mode !== "comparison" && mode !== "export")
    throw new Error("Unknown rendering mode.");
  const requestedOutput = options.get("--output-dir");
  if (!isAbsolute(requestedOutput))
    throw new Error("Output directory must be absolute.");
  const output = await realpath(requestedOutput);
  const temporaryRoots = await Promise.all([
    realpath(tmpdir()),
    realpath("/tmp"),
  ]);
  if (
    !temporaryRoots.some((temporaryRoot) => inside(temporaryRoot, output)) ||
    inside(repository, output)
  ) {
    throw new Error(
      "Output must be an owned directory under the system temporary root.",
    );
  }
  const outputStat = await stat(output);
  if (
    !outputStat.isDirectory() ||
    (outputStat.mode & 0o077) !== 0 ||
    outputStat.uid !== process.getuid()
  ) {
    throw new Error(
      "Output directory must already exist and be private (0700).",
    );
  }
  if ((await readdir(output)).length)
    throw new Error("Output directory must be empty.");
  const design = await realpath(options.get("--design-root"));
  const tokens = JSON.parse(
    await readFile(join(design, "tokens/tokens.json"), "utf8"),
  );
  if (tokens.version !== manifest.designVersion)
    throw new Error("Design version mismatch.");
  const { width, height } = frame.canvas ?? manifest.canvas;
  const tile = frame.kind === "tile";
  const icon = tile
    ? `data:image/png;base64,${(await readFile(join(design, frame.icon))).toString("base64")}`
    : undefined;
  const harness = join(output, ".harness");
  await mkdir(harness, { mode: 0o700 }); // Refuse to overwrite a previous proof run.
  await mkdir(join(harness, "node_modules"), { mode: 0o700 });
  await symlink(
    await realpath(join(repository, "node_modules/svelte")),
    join(harness, "node_modules/svelte"),
    "dir",
  );
  const fromFs = (path) => `/@fs/${path}`;
  const frameJson = JSON.stringify(frame);
  const entry = `
import { mount } from 'svelte';
import { FEATURE_REGISTRY } from '@still/shared-types';
import StoreAssets from ${JSON.stringify(fromFs(join(here, "StoreAssets.svelte")))};
import ${JSON.stringify(fromFs(join(design, "styles.css")))};
const frame = ${frameJson};
${
  tile
    ? `
mount(StoreAssets,{target:document.querySelector('#root'),props:{
  id:frame.id,headline:frame.headline,body:frame.body,kind:'tile',
  width:${width},height:${height},icon:${JSON.stringify(icon)}}});
`
    : `
const settings = Object.freeze({ schemaVersion:2, globalOn:true,
  services:Object.freeze({youtube:true,instagram:true,facebook:true,tiktok:true}),
  sites:Object.freeze(Object.fromEntries(FEATURE_REGISTRY.map(row=>[row.id,
    row.tier==='free'||row.id==='youtube.comments'||row.id==='youtube.related']))),
  clocks:Object.freeze({}), updatedAt:0 });
const access = Object.freeze({ schema:1,generation:0,refreshAfterMs:null,
  independentProtection:Object.freeze([]),
  states:Object.freeze(Object.fromEntries([...FEATURE_REGISTRY.map(row=>[row.id,
    row.tier==='free'?'free':frame.proAccess]),['tiktok.all','free']])) });
mount(StoreAssets,{target:document.querySelector('#root'),props:{
  id:frame.id,headline:frame.headline,body:frame.body,browser:frame.browser,
  kind:frame.kind,width:${width},height:${height},uiBase:frame.uiBase,
  view:{purpose:'synthetic-reference-only',settings,access,services:frame.services,
    features:frame.mobile?FEATURE_REGISTRY.filter(row=>row.id!=='facebook.sidebar_ads').map(row=>row.id):undefined,
    open:frame.open,account:frame.account}}});
`
}
window.referenceFixturePurpose='synthetic-reference-only';
`;
  const comparison = mode === "comparison";
  const origin = comparison ? frame.origin : { x: 0, y: 0 };
  const radius = comparison
    ? manifest.comparison.parentRadius
    : manifest.export.parentRadius;
  const html = `<!doctype html><html data-theme="light"><meta charset="utf-8">
<style>html,body{margin:0}body{background:${manifest.comparison.parentBackground};
font-family:var(--font-ui);-webkit-font-smoothing:antialiased}
#root{position:absolute;left:${origin.x}px;top:${origin.y}px;width:${width}px;height:${height}px;
overflow:hidden;border-radius:${radius}px;--text-scale:1}</style>
<div id="root"></div><script type="module" src="/entry.js"></script></html>`;
  await writeFile(join(harness, "entry.js"), entry, { mode: 0o600 });
  await writeFile(join(harness, "index.html"), html, { mode: 0o600 });
  // pnpm keeps vitest (which re-exports Vite's server) and the Svelte plugin under packages/core, not the repository root.
  const coreRequire = createRequire(
    join(repository, "packages/core/package.json"),
  );
  const importCore = (id) =>
    import(pathToFileURL(coreRequire.resolve(id)).href);
  const [{ createViteServer: createServer }, { svelte }, { chromium }] =
    await Promise.all([
      importCore("vitest/node"),
      importCore("@sveltejs/vite-plugin-svelte"),
      import("@playwright/test"),
    ]);
  let server;
  let browser;
  const errors = [];
  let serverAddress;
  try {
    server = await createServer({
      root: harness,
      configFile: false,
      cacheDir: join(harness, ".vite"),
      plugins: [svelte()],
      resolve: {
        dedupe: ["svelte"],
        alias: {
          "@still/shared-types": join(
            repository,
            "packages/shared-types/src/index.ts",
          ),
        },
      },
      server: {
        host: "127.0.0.1",
        port: 0,
        fs: { allow: [repository, design, output] },
      },
    });
    await server.listen();
    serverAddress = server.httpServer.address();
    browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor:
        manifest[mode === "comparison" ? "comparison" : "export"]
          .deviceScaleFactor,
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${serverAddress.port}`, {
      waitUntil: "networkidle",
    });
    await page.evaluate(() => document.fonts.ready);
    await page.locator("[data-asset]").waitFor();
    await page.waitForTimeout(250); // Let the original 220ms expander reach its declared state.
    const observed = await page.locator("[data-asset]").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        background: getComputedStyle(element).backgroundColor,
        purpose: element.dataset.purpose,
        inert: element.inert,
        fontLoaded: document.fonts.check('16px "InterVariable"'),
        fontStatus: document.fonts.status,
        openSections: document.querySelectorAll(".service-options.open").length,
        uiTheme:
          element.querySelector(".still-ui")?.dataset.theme ??
          document.documentElement.dataset.theme,
      };
    });
    if (tile) {
      observed.tileArtworkLoaded = await page
        .locator("[data-asset] img")
        .evaluate((image) => image.complete && image.naturalWidth === 1024);
    }
    if (frame.browser) {
      observed.settingsHostLabel = await page
        .locator(".open-options")
        .getAttribute("aria-label");
    }
    if (
      errors.length ||
      !observed.fontLoaded ||
      (tile && !observed.tileArtworkLoaded) ||
      observed.purpose !== manifest.purpose
    ) {
      throw new Error(
        `Unhealthy render: ${JSON.stringify({ errors, observed })}`,
      );
    }
    const destination = join(output, `${frame.id}-${mode}.png`);
    await page
      .locator("[data-asset]")
      .screenshot({ path: destination, animations: "disabled" });
    await chmod(destination, 0o600);
    const buffer = await readFile(destination);
    const dimensions = [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
    const scale = comparison ? 2 : 1;
    if (dimensions[0] !== width * scale || dimensions[1] !== height * scale) {
      throw new Error(`Incorrect raster dimensions: ${dimensions}`);
    }
    const result = {
      id: frame.id,
      mode,
      designVersion: manifest.designVersion,
      purpose: manifest.purpose,
      publication: manifest.publication,
      destination,
      dimensions,
      reference: frame.reference,
      observed,
      errors,
      serverAddress,
      reviewParentRadius: radius,
      operationalProof: false,
    };
    await writeFile(
      join(output, "result.json"),
      JSON.stringify(result, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(JSON.stringify(result));
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      if (server) await server.close();
    }
    console.log(
      JSON.stringify({ cleanup: "browser/server closed", serverAddress }),
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
