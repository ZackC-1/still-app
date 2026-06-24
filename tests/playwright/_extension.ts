import { test as base, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

// Loads the built Chromium extension into a persistent context (KTD10). `channel: 'chromium'` uses
// Chromium-for-Testing, which runs MV3 extensions headless. The extension id is derived from the
// background service worker's URL.

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = resolve(HERE, "../../packages/ext-chromium/dist/chrome-mv3");
const FIXTURE_DIR = resolve(HERE, "../fixtures");

export function fixture(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), "utf8");
}

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require this destructure form
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = (await context.waitForEvent("serviceworker")) as Worker;
    await use(new URL(worker.url()).host);
  },
});

export const expect = test.expect;
