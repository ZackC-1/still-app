// Shared by the QA specs (TypeScript) and the real-extension visual runner (plain Node): load the
// built Chrome extension into Chromium-for-Testing and reach the extension's own storage through
// its service worker. Real storage and real messages only: no product hook exists or is added.
import { chromium } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The unpacked build under test. STILL_CHROMIUM_EXTENSION points it at another build (the configured lane). */
export const CHROMIUM_EXTENSION = process.env.STILL_CHROMIUM_EXTENSION
  ? resolve(process.env.STILL_CHROMIUM_EXTENSION)
  : resolve(HERE, "../../../packages/ext-chromium/dist/chrome-mv3");

/**
 * Launch a fresh profile with the extension loaded.
 * @param {{ extensionPath?: string, deviceScaleFactor?: number, colorScheme?: "light" | "dark", locale?: string }} [options]
 */
export function launchExtension({
  extensionPath = CHROMIUM_EXTENSION,
  deviceScaleFactor = 2,
  colorScheme = "light",
  locale = "en-US",
} = {}) {
  return chromium.launchPersistentContext("", {
    channel: "chromium",
    deviceScaleFactor,
    colorScheme,
    locale,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
}

/** The extension's background service worker. */
export async function serviceWorker(context) {
  const [worker] = context.serviceWorkers();
  return worker ?? context.waitForEvent("serviceworker");
}

export async function extensionIdOf(context) {
  return new URL((await serviceWorker(context)).url()).host;
}

/** Read one chrome.storage.local key through the extension's own context. */
export async function readStore(context, key) {
  const worker = await serviceWorker(context);
  return worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? null, key);
}

/** Write real storage through the extension's own context (the same call the product makes). */
export async function writeStore(context, items) {
  const worker = await serviceWorker(context);
  await worker.evaluate((values) => chrome.storage.local.set(values), items);
}

/** Wait until the background has committed this profile's schema-2 settings (V3 builds only). */
export async function waitForCommittedSettings(context, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const record = await readStore(context, "still:settings");
    if (record?.settings?.schemaVersion === 2) return record;
    if (Date.now() > deadline) throw new Error("The background never committed schema-2 settings");
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** Open an extension page (popup, options, first-run, tiktok-blocked) at a given viewport. */
export async function openExtensionPage(context, extensionId, name, { width, height, colorScheme, query = "" } = {}) {
  const page = await context.newPage();
  if (width && height) await page.setViewportSize({ width, height });
  if (colorScheme) await page.emulateMedia({ colorScheme });
  await page.goto(`chrome-extension://${extensionId}/${name}.html${query}`);
  await page.evaluate(() => document.fonts.ready);
  return page;
}
