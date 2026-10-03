import { test as base, chromium, type Worker } from "@playwright/test";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUILT = join(ROOT, "packages/ext-chromium/dist/chrome-mv3");

async function artifactHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      const child = join(dir, name);
      if ((await stat(child)).isDirectory()) await visit(child);
      else hash.update(child.slice(path.length)).update(await readFile(child));
    }
  }
  await visit(path);
  return hash.digest("hex");
}

// Only a disposable copy opts into format2. Shipping entrypoints, manifests, permissions and
// output remain byte-identical. Bundle current maintained source, not a substitute classifier.
async function prepareCopy(dir: string) {
  const copy = join(dir, "extension");
  await cp(BUILT, copy, { recursive: true });
  const manifest = JSON.parse(
    await readFile(join(copy, "manifest.json"), "utf8"),
  );
  const coreRequire = createRequire(join(ROOT, "packages/core/package.json"));
  const vitestRequire = createRequire(
    coreRequire.resolve("vitest/package.json"),
  );
  const viteRequire = createRequire(vitestRequire.resolve("vite"));
  const { build } = viteRequire("esbuild") as {
    build: (options: Record<string, unknown>) => Promise<unknown>;
  };
  const source = (path: string) => JSON.stringify(join(ROOT, path));
  const worker = `
    import { DEFAULT_SETTINGS } from "@still/shared-types";
    import { ChromeStorageAdapter, createSettingsIntentRouter } from ${source("packages/core/src/storage/index.ts")};
    const authority = new ChromeStorageAdapter({ authority: true });
    chrome.runtime.onMessage.addListener(createSettingsIntentRouter(
      intent => authority.commitIntent(intent), chrome.runtime.id, chrome.runtime.getURL(""), record => authority.set(record)));
    globalThis.fixtureAuthority = authority;
    globalThis.fixtureReady = (async () => {
      await authority.set({settings:{...DEFAULT_SETTINGS, updatedAt:1},syncMetadata:null});
      await authority.initializeAtomic("never-linked");
      // Isolate the content guard from shipping DNR; the copied manifest/rules stay unchanged.
      await chrome.declarativeNetRequest.updateEnabledRulesets({disableRulesetIds:["youtube-shorts-redirect"]});
    })();`;
  const content = `
    import { createExtensionContentEntry } from ${source("packages/core/src/content/extension-entry.ts")};
    import { ruleSet } from ${source("packages/core/src/rules/__tests__/format2-fixtures.ts")};
    let script;
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if(message.kind === "fixture.stop") { script?.stop(); reply(true); }
    });
    void createExtensionContentEntry({storage:chrome.storage.local, bundledRuleSetV2:ruleSet,
      prod:false, earlyRedirect:false, onScriptCreated:s=>script=s})();`;
  for (const [name, contents, target] of [
    ["worker", worker, manifest.background.service_worker],
    ["content", content, manifest.content_scripts[0].js[0]],
  ]) {
    const entry = join(dir, `${name}.ts`);
    await writeFile(entry, contents);
    await build({
      entryPoints: [entry],
      outfile: join(copy, target),
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "chrome120",
      logLevel: "silent",
      alias: {
        "@still/shared-types": join(ROOT, "packages/shared-types/src/index.ts"),
      },
    });
  }
  if (
    !(await readFile(join(copy, "manifest.json"))).equals(
      await readFile(join(BUILT, "manifest.json")),
    )
  )
    throw new Error("Test copy changed shipping manifest");
  return copy;
}

export const test = base.extend<{ authority: Worker }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
  context: async ({}, use) => {
    const original = await artifactHash(BUILT);
    const dir = await mkdtemp(join(tmpdir(), "still-format2-navigation-"));
    let context;
    try {
      const copy = await prepareCopy(dir);
      context = await chromium.launchPersistentContext(join(dir, "profile"), {
        channel: "chromium",
        args: [
          `--disable-extensions-except=${copy}`,
          `--load-extension=${copy}`,
        ],
      });
      let [worker] = context.serviceWorkers();
      worker ??= await context.waitForEvent("serviceworker");
      await worker.evaluate(async () => {
        await (globalThis as unknown as { fixtureReady: Promise<void> })
          .fixtureReady;
      });
      await use(context);
    } finally {
      try {
        await context?.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
        base.expect(await artifactHash(BUILT), "Shipping artifact stays unchanged").toBe(original);
      }
    }
  },
  authority: async ({ context }, use) => {
    await use(context.serviceWorkers()[0]!);
  },
});
export const expect = test.expect;
