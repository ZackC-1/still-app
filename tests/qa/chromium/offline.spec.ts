import { test, expect } from "../shared/fixtures.js";
import { NEEDS_BACKEND, V3_ONLY, syncConfigured } from "../shared/lane.js";
import { FIRST_RUN, serveFixture } from "../shared/serve.js";
import { openExtensionPage, readStore, waitForCommittedSettings } from "../shared/launch.mjs";

// J9.CH: no network at all. Recorded pages are served from disk by the harness, the extension's own
// pages load from the install, and the person still gets blocking and working switches, with no
// error state. V3 build only.

test.skip(syncConfigured, V3_ONLY);

type Saved = { settings: { globalOn: boolean; services: Record<string, boolean> } };
const saved = async (context: Parameters<typeof readStore>[0]) => (await readStore(context, "still:settings")) as Saved;

test("J9.CH blocking works offline and a settings edit is saved on the device", async ({
  context,
  extensionId,
  network,
  evidence,
}) => {
  const ev = evidence("J9.CH");
  await waitForCommittedSettings(context);
  await Promise.all(context.pages().filter((p) => FIRST_RUN.test(p.url())).map((p) => p.close()));
  await context.setOffline(true);

  const youtube = await context.newPage();
  await serveFixture(youtube, "**://*.youtube.com/**", "youtube.html");
  await youtube.goto("https://www.youtube.com/feed/subscriptions");
  await expect(youtube.locator("#shelf")).toBeHidden();
  await expect(youtube.locator("#rich-shorts-section")).toBeHidden();
  await expect(youtube.locator("#keep-video")).toBeVisible();
  await ev.shot(youtube, "youtube-blocked-offline");

  const popup = await openExtensionPage(context, extensionId, "popup", { width: 380, height: 600 });
  await expect(popup.getByRole("heading", { name: "Still is active" })).toBeVisible();
  await popup.getByRole("switch", { name: "Still on YouTube", exact: true }).click();
  await expect.poll(async () => (await saved(context)).settings.services.youtube).toBe(false);
  await expect(youtube.locator("#shelf")).toBeVisible();

  // No error state anywhere: nothing here is signed in, so there is no sync line to fail.
  const text = (await popup.locator("body").innerText()).replace(/\s+/g, " ");
  expect(text).not.toMatch(/couldn.t|failed|offline|error|try again|no connection/i);
  await ev.shot(popup, "popup-offline-no-error");
  await ev.storage(context, "offline-edit-saved");

  // Nothing left the machine: the only requests are the recorded pages the harness answered.
  const external = network.external().filter((entry) => !/\.(youtube)\.com$/.test(new URL(entry.origin).hostname));
  expect(external).toEqual([]);

  await context.setOffline(false);
  await popup.getByRole("switch", { name: "Still on YouTube", exact: true }).click();
  await expect.poll(async () => (await saved(context)).settings.services.youtube).toBe(true);
  await expect(youtube.locator("#shelf")).toBeHidden();
});

test("J9.CH the extension's own pages open offline", async ({ context, extensionId, evidence }) => {
  const ev = evidence("J9.CH");
  await waitForCommittedSettings(context);
  await context.setOffline(true);
  for (const name of ["options", "first-run"] as const) {
    const page = await openExtensionPage(context, extensionId, name, { width: 600, height: 900 });
    await expect(page.locator("h1").first()).toBeVisible();
    await ev.shot(page, `${name}-offline`);
  }
});

test.fixme("J9.CH a settings edit made offline syncs when the connection returns", async () => {
  // NEEDS_BACKEND: needs a signed-in session against the QA-P7 local backend, then
  // context.setOffline(false) and a check of the server row.
  expect(NEEDS_BACKEND).toBeTruthy();
});
