/* eslint-disable no-empty-pattern -- Playwright requires a destructured first argument, and these tests use none of its fixtures */
import { test, expect } from "@playwright/test";
import { FirefoxEvidence } from "./_qa-evidence.js";
import {
  FIRST_RUN_URL,
  NEEDS_BACKEND,
  firstRunTab,
  readStore,
  reinstall,
  savedSettings,
  startFresh,
  storeDump,
  tabsWith,
} from "./_qa-session.js";
import type { StillFirefox } from "./_session.js";

// J8.FD: remove Still and add it back in the same Firefox profile. Firefox clears an add-on's
// storage on removal, so adding it back is a fresh install: the first-run page opens once more and
// the defaults are saved again. The browser's own first-run note is dated again.

let firefox: StillFirefox;
test.beforeEach(async () => {
  firefox = await startFresh();
});
test.afterEach(async () => {
  await firefox?.stop();
});

type Original = { firstRecordedAt: number; firstRecordedAppVersion: string };

test("J8.FD removing and re-adding Still in the same profile is a fresh install", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const ev = new FirefoxEvidence("J8.FD", testInfo, firefox);
  await ev.shot("first-run", "first-install-first-run");
  await (await firstRunTab(firefox)).close();

  // The person changes a choice.
  const popup = await firefox.openExtensionPage("popup.html");
  await popup.waitFor(
    "the Instagram switch",
    () => popup.count('button[role=switch][aria-label="Still on Instagram"]'),
    (n) => n === 1,
  );
  await popup.evaluate(
    `document.querySelector('button[role=switch][aria-label="Still on Instagram"]').click()`,
  );
  await popup.waitFor(
    "saved",
    async () => (await savedSettings(firefox)).settings.services.instagram,
    (v) => v === false,
  );
  await popup.close();
  const original = (await readStore<Original>(
    firefox,
    "still:originalInstall",
  ))!;
  expect(original.firstRecordedAt).toBeGreaterThan(0);

  await reinstall(firefox);

  // A new install: first-run opens once and the earlier choice is gone.
  await firstRunTab(firefox);
  await ev.shot("first-run", "reinstall-first-run");
  await new Promise((done) => setTimeout(done, 1500));
  expect(
    await tabsWith(firefox, FIRST_RUN_URL),
    "first-run opens once",
  ).toHaveLength(1);
  await firefox.waitForModernSettings();
  expect((await savedSettings(firefox)).settings.services).toEqual({
    youtube: true,
    instagram: true,
    facebook: true,
    tiktok: true,
  });
  const again = (await readStore<Original>(firefox, "still:originalInstall"))!;
  expect(again.firstRecordedAt).toBeGreaterThan(original.firstRecordedAt);
  expect(again.firstRecordedAppVersion).toBe(original.firstRecordedAppVersion);
  ev.log("original-install-records", { before: original, after: again });
  expect(Object.keys(await storeDump(firefox)).sort()).toEqual([
    "still:originalInstall",
    "still:settings",
  ]);
});

test.fixme("J8.FD a signed-in account restores its settings after sign-in on the re-added extension", async () => {
  expect(NEEDS_BACKEND).toBeTruthy();
});
