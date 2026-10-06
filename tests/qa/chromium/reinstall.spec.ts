import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Evidence } from "../shared/evidence.js";
import { NEEDS_BACKEND, V3_ONLY, syncConfigured } from "../shared/lane.js";
import { CHROMIUM_EXTENSION } from "../shared/launch.mjs";
import { launchWithExtensionLoader } from "../shared/loader.js";
import { FIRST_RUN } from "../shared/serve.js";
import type { Page } from "@playwright/test";

// J8.CH: remove Still and add it back in the same Chrome profile. Chrome clears an extension's
// storage when it is removed, so a re-add is a fresh install: the first-run page opens once more
// and the defaults are saved again. The original-install record is the browser's own note of its
// first run; it cannot outlive the removal, so it is dated again. V3 build only.

test.skip(syncConfigured, V3_ONLY);

type Saved = { settings?: { globalOn?: boolean; services?: Record<string, boolean> } } | null;

async function storageOf(page: Page, key: string): Promise<unknown> {
  return page.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? null, key);
}

test("J8.CH removing and re-adding Still in the same profile is a fresh install", async ({}, testInfo) => { // eslint-disable-line no-empty-pattern
  test.setTimeout(120_000);
  const ev = new Evidence("J8.CH", testInfo);
  const work = mkdtempSync(join(tmpdir(), "still-qa-reinstall-"));
  let browser: Awaited<ReturnType<typeof launchWithExtensionLoader>> | undefined;
  try {
    browser = await launchWithExtensionLoader(join(work, "profile"));
    const { context } = browser;

    // First install: first-run opens, defaults are saved, and the person changes a choice.
    const firstOpen = context.waitForEvent("page", { predicate: (p) => FIRST_RUN.test(p.url()), timeout: 20_000 });
    const { id } = await browser.load(CHROMIUM_EXTENSION);
    const first = await firstOpen;
    await first.evaluate(() => document.fonts.ready);
    await ev.shot(first, "first-install-first-run");
    await first.close();

    const probe = await context.newPage();
    await probe.goto(`chrome-extension://${id}/options.html`);
    await probe.evaluate(() => document.fonts.ready);
    await expect.poll(async () => ((await storageOf(probe, "still:settings")) as Saved)?.settings?.schemaVersion ?? null, {
      timeout: 15_000,
    }).toBe(2);
    await probe.getByRole("switch", { name: "Still on Instagram", exact: true }).click();
    await expect.poll(async () => ((await storageOf(probe, "still:settings")) as Saved)?.settings?.services?.instagram).toBe(false);
    const original = (await storageOf(probe, "still:originalInstall")) as { firstRecordedAt: number; firstRecordedAppVersion: string };
    expect(original.firstRecordedAt).toBeGreaterThan(0);
    await probe.close();

    // Remove it.
    await browser.uninstall(id);
    const gone = await context.newPage();
    const reachable = await gone.goto(`chrome-extension://${id}/options.html`).then(
      (response) => response?.ok() ?? false,
      () => false,
    );
    expect(reachable, "the removed extension no longer serves its pages").toBe(false);
    await gone.close();
    await new Promise((done) => setTimeout(done, 1500));

    // Add it back: a new install.
    const secondOpen = context.waitForEvent("page", { predicate: (p) => FIRST_RUN.test(p.url()), timeout: 20_000 });
    const again = await browser.load(CHROMIUM_EXTENSION);
    const second = await secondOpen;
    await second.evaluate(() => document.fonts.ready);
    await expect(second.getByRole("heading", { level: 1 })).toHaveText("Still is on.");
    await ev.shot(second, "reinstall-first-run");
    await new Promise((done) => setTimeout(done, 1500));
    expect(context.pages().filter((p) => FIRST_RUN.test(p.url())), "first-run opens once").toHaveLength(1);

    const reader = await context.newPage();
    await reader.goto(`chrome-extension://${again.id}/options.html`);
    await expect.poll(async () => ((await storageOf(reader, "still:settings")) as Saved)?.settings?.schemaVersion ?? null, {
      timeout: 15_000,
    }).toBe(2);
    // Defaults are saved again: the earlier choice did not survive the removal.
    expect(((await storageOf(reader, "still:settings")) as Saved)?.settings?.services).toEqual({
      youtube: true,
      instagram: true,
      facebook: true,
      tiktok: true,
    });
    const reinstalled = (await storageOf(reader, "still:originalInstall")) as typeof original;
    // The browser's own first-run note is written afresh: later than the first, same build version.
    expect(reinstalled.firstRecordedAt).toBeGreaterThan(original.firstRecordedAt);
    expect(reinstalled.firstRecordedAppVersion).toBe(original.firstRecordedAppVersion);
    ev.log("original-install-records", { before: original, after: reinstalled });
  } finally {
    await browser?.close();
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      console.warn(`could not remove ${work}: ${String(error)}`);
    }
  }
});

test.fixme("J8.CH a signed-in account restores its settings after sign-in on the re-added extension", async () => {
  // NEEDS_BACKEND: needs the QA-P7 local backend recipe (sign-in with a code from the local mailbox).
  expect(NEEDS_BACKEND).toBeTruthy();
});
