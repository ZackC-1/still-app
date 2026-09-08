import { test as base, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

// Loads a built extension into a persistent context (KTD10). `channel: 'chromium'` uses
// Chromium-for-Testing, which runs MV3 extensions headless. The extension id is derived from the
// background service worker's URL.

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROMIUM_EXTENSION = resolve(HERE, "../../packages/ext-chromium/dist/chrome-mv3");
const SAFARI_EXTENSION = resolve(HERE, "../../packages/ext-safari/dist/safari-mv3");
const FIXTURE_DIR = resolve(HERE, "../fixtures");

export function fixture(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), "utf8");
}

function loadExtension(path: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
  });
}

async function extensionIdOf(context: BrowserContext): Promise<string> {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = (await context.waitForEvent("serviceworker")) as Worker;
  return new URL(worker.url()).host;
}

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  safariContext: BrowserContext;
  safariExtensionId: string;
}>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require this destructure form
  context: async ({}, use) => {
    const context = await loadExtension(CHROMIUM_EXTENSION);
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    await use(await extensionIdOf(context));
  },

  // The Safari build, loaded the same way. It is a separate bundle with its own popup copy and its
  // own setup guidance, and copy is what decides how wide a popup wants to be, so sizing assertions
  // that only ever see the Chromium bundle are not checking the surface the phone bug came from.
  // The engine here is still Blink: this covers the Safari BUILD, not the Safari engine, and it
  // says nothing about how a real Safari popover or iOS sheet hosts the document. Only tests that
  // ask for these fixtures pay the cost of a second browser launch.
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require this destructure form
  safariContext: async ({}, use) => {
    const context = await loadExtension(SAFARI_EXTENSION);
    await use(context);
    await context.close();
  },
  safariExtensionId: async ({ safariContext }, use) => {
    await use(await extensionIdOf(safariContext));
  },
});

export const expect = test.expect;
