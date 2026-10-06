import type { Page, Worker } from "@playwright/test";
import { test, expect } from "./_extension.js";

// After the popup has read its settings, a storage change it cannot parse (here another extension
// context removes the settings record, later putting the same record back) makes the committed
// (V3) popup reread the slot. While that reread is in flight the popup keeps showing the last good
// settings, read-only, and never flashes "Settings are unavailable."; a reread that genuinely fails
// still shows that state. Configured store builds keep the legacy popup, so this is V3 only.
const syncConfigured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
test.skip(syncConfigured, "The committed (V3) popup runs on unconfigured builds only.");
test.use({ settingsProfile: "modern" });

const UNAVAILABLE = "Settings are unavailable.";

type Probe = {
  mode: "pass" | "delay" | "fail";
  armedReads: number;
  sawUnavailable: boolean;
  sawHeld: boolean;
  settingsWrites: number;
};

/** The popup's own settings reads pass through until armed; then they are delayed or fail. */
async function armableSettingsRead(page: Page) {
  await page.addInitScript(() => {
    const probe: Probe = {
      mode: "pass",
      armedReads: 0,
      sawUnavailable: false,
      sawHeld: false,
      settingsWrites: 0,
    };
    (window as unknown as { stillProbe: Probe }).stillProbe = probe;
    const area = (
      globalThis as unknown as {
        chrome: {
          storage: {
            local: {
              get: (...a: unknown[]) => Promise<unknown>;
              set: (...a: unknown[]) => Promise<unknown>;
            };
          };
        };
      }
    ).chrome.storage.local;
    const get = area.get.bind(area);
    const set = area.set.bind(area);
    const touchesSettings = (keys: unknown) =>
      keys === "still:settings" ||
      (Array.isArray(keys) && keys.includes("still:settings")) ||
      (keys !== null &&
        typeof keys === "object" &&
        !Array.isArray(keys) &&
        "still:settings" in keys);
    area.get = (...args: unknown[]) => {
      if (!touchesSettings(args[0]) || probe.mode === "pass") return get(...args);
      probe.armedReads += 1;
      if (probe.mode === "fail")
        return Promise.reject(new Error("synthetic storage failure"));
      return new Promise((resolve) => setTimeout(resolve, 2_000)).then(() =>
        get(...args),
      );
    };
    area.set = (...args: unknown[]) => {
      if (touchesSettings(args[0])) probe.settingsWrites += 1;
      return set(...args);
    };
    new MutationObserver(() => {
      if (probe.mode === "pass") return;
      if ((document.body?.textContent ?? "").includes("Settings are unavailable."))
        probe.sawUnavailable = true;
      const global = document.querySelector<HTMLButtonElement>('[role="switch"]');
      if (global?.disabled || global?.getAttribute("aria-disabled") === "true")
        probe.sawHeld = true;
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
}

const probe = (page: Page) =>
  page.evaluate(() => (window as unknown as { stillProbe: Probe }).stillProbe);
const arm = (page: Page, mode: Probe["mode"]) =>
  page.evaluate((mode) => {
    (window as unknown as { stillProbe: Probe }).stillProbe.mode = mode;
  }, mode);

type StorageWorker = {
  chrome: { storage: { local: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
  } } };
};

/**
 * Another extension context's change the popup cannot parse: it removes the settings record. The
 * popup must reread the slot; `restore` puts the same record back (a parseable change it applies).
 */
async function externalRemoval(worker: Worker): Promise<string> {
  return worker.evaluate(async () => {
    const local = (globalThis as unknown as StorageWorker).chrome.storage.local;
    const record = (await local.get("still:settings"))["still:settings"];
    await local.remove("still:settings");
    return JSON.stringify(record);
  });
}
async function restore(worker: Worker, record: string): Promise<void> {
  await worker.evaluate(async (record) => {
    await (globalThis as unknown as StorageWorker).chrome.storage.local.set({
      "still:settings": JSON.parse(record),
    });
  }, record);
}
const storedRecord = (worker: Worker) =>
  worker.evaluate(async () => {
    const raw = await (globalThis as unknown as StorageWorker).chrome.storage.local.get(
      "still:settings",
    );
    return "still:settings" in raw ? JSON.stringify(raw["still:settings"]) : undefined;
  });

async function openReadyPopup(
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
) {
  await context.route(/^https?:/, (route) => route.abort());
  const page = await context.newPage();
  await armableSettingsRead(page);
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const global = page.getByRole("switch").first();
  await expect(page.getByRole("switch")).toHaveCount(5, { timeout: 10_000 });
  await expect(global).toBeEnabled();
  const [worker] = context.serviceWorkers();
  return { page, global, worker: worker! };
}

test("an external write during an open popup with a delayed reread never flashes unavailable", async ({
  context,
  extensionId,
}) => {
  const { page, global, worker } = await openReadyPopup(context, extensionId);
  const checked = await global.getAttribute("aria-checked");
  await arm(page, "delay");
  const before = await externalRemoval(worker);
  await expect.poll(async () => (await probe(page)).armedReads).toBeGreaterThan(0);
  // In flight (the delayed reread answers after 2 s): the last good choices, read-only.
  await expect(global).toBeDisabled();
  await expect(global).toHaveAttribute("aria-checked", checked!);
  await page.waitForTimeout(1_000);
  await expect(page.getByText(UNAVAILABLE)).toHaveCount(0);
  await expect(global).toBeDisabled();
  await restore(worker, before);
  await expect(global).toBeEnabled({ timeout: 10_000 });
  // Let the delayed reread itself answer too.
  await page.waitForTimeout(2_000);
  await expect(global).toBeEnabled();
  const seen = await probe(page);
  expect(seen.sawHeld, "the reread was never pending").toBe(true);
  expect(
    seen.sawUnavailable,
    "the popup flashed the unavailable state during the reread",
  ).toBe(false);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(global).toHaveAttribute("aria-checked", checked!);
  expect(seen.settingsWrites).toBe(0);
  expect(await storedRecord(worker)).toBe(before);
});

test("an external write whose reread fails still shows the unavailable state", async ({
  context,
  extensionId,
}) => {
  const { page, global, worker } = await openReadyPopup(context, extensionId);
  const checked = await global.getAttribute("aria-checked");
  await arm(page, "fail");
  const before = await externalRemoval(worker);
  await expect(page.getByText(UNAVAILABLE)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
  await expect(global).toBeDisabled();
  await expect(global).toHaveAttribute("aria-checked", checked!);
  expect((await probe(page)).settingsWrites).toBe(0);
  // The popup rewrote nothing: the slot stays removed until the other context restores it.
  expect(await storedRecord(worker)).toBeUndefined();
  await restore(worker, before);
  expect(await storedRecord(worker)).toBe(before);
  expect((await probe(page)).settingsWrites).toBe(0);
});
