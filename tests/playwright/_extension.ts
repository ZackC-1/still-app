import { test as base, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

// Loads a built extension into a persistent context (KTD10). `channel: 'chromium'` uses
// Chromium-for-Testing, which runs MV3 extensions headless. The extension id is derived from the
// background service worker's URL.

const HERE = dirname(fileURLToPath(import.meta.url));
// STILL_CHROMIUM_EXTENSION points the Chromium fixtures at another built artifact, e.g. a
// configured (store-like) build made into a temporary directory. Default: the CI build.
const CHROMIUM_EXTENSION = process.env.STILL_CHROMIUM_EXTENSION
  ? resolve(process.env.STILL_CHROMIUM_EXTENSION)
  : resolve(HERE, "../../packages/ext-chromium/dist/chrome-mv3");
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

/**
 * The saved-settings shape the Chromium profile holds before any test page loads. The content
 * script picks its engine from it once per page, so a test that cares must not race the
 * background's install-time initialization:
 * - "fresh": no setup (the page may load before or after the background initializes settings);
 * - "modern": wait until the background has committed schema-2 settings (the format-2 lane on
 *   an unconfigured build, as a fresh atomic-local install has);
 * - "legacy": a schema-1 settings document, as configured store builds keep until the modern
 *   settings rollout (the legacy seed engine).
 */
export type SettingsProfile = "fresh" | "modern" | "legacy";

type StorageWorker = {
  chrome: { storage: { local: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  } } };
};

async function storedSchema(worker: Worker): Promise<number | null> {
  return worker.evaluate(async () => {
    const raw = await (globalThis as unknown as StorageWorker).chrome.storage.local.get("still:settings");
    const record = raw["still:settings"] as { settings?: { schemaVersion?: number } } | undefined;
    return record?.settings ? (record.settings.schemaVersion ?? 1) : null;
  });
}

async function applyProfile(context: BrowserContext, profile: SettingsProfile): Promise<void> {
  if (profile === "fresh") return;
  let [worker] = context.serviceWorkers();
  if (!worker) worker = (await context.waitForEvent("serviceworker")) as Worker;
  if (profile === "modern") {
    const deadline = Date.now() + 15_000;
    while ((await storedSchema(worker)) !== 2) {
      if (Date.now() > deadline) throw new Error("Background never committed schema-2 settings");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return;
  }
  // Legacy: let an install-time initialization land first (unconfigured builds write one at
  // install; configured builds never do), then replace it with the schema-1 document once.
  const settle = Date.now() + 3_000;
  while ((await storedSchema(worker)) === null && Date.now() < settle)
    await new Promise((resolve) => setTimeout(resolve, 50));
  await worker.evaluate(async () => {
    await (globalThis as unknown as StorageWorker).chrome.storage.local.set({
      "still:settings": {
        settings: {
          globalOn: true,
          services: { youtube: true, instagram: true, tiktok: true, facebook: true },
          pauses: [],
          updatedAt: 5,
        },
        syncMetadata: null,
      },
    });
  });
  if ((await storedSchema(worker)) !== 1) throw new Error("Could not hold a legacy settings profile");
  // A format-2 build mirrors schema-2 choices as session redirect rules; wait until the legacy
  // document has retired them, so a legacy-lane page never meets a format-2 network redirect.
  const retired = Date.now() + 5_000;
  while ((await sessionRuleCount(worker)) > 0) {
    if (Date.now() > retired) throw new Error("Format-2 session rules outlived the legacy settings profile");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The extension's declarativeNetRequest session rules (0 where the API is absent). */
async function sessionRuleCount(worker: Worker): Promise<number> {
  return worker.evaluate(async () => {
    const dnr = (globalThis as unknown as {
      chrome: { declarativeNetRequest?: { getSessionRules?: () => Promise<unknown[]> } };
    }).chrome.declarativeNetRequest;
    return dnr?.getSessionRules ? (await dnr.getSessionRules()).length : 0;
  });
}

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  safariContext: BrowserContext;
  safariExtensionId: string;
  settingsProfile: SettingsProfile;
}>({
  settingsProfile: ["fresh", { option: true }],
  context: async ({ settingsProfile }, use) => {
    const context = await loadExtension(CHROMIUM_EXTENSION);
    await applyProfile(context, settingsProfile);
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
