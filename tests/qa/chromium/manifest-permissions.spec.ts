import { test, expect } from "../shared/fixtures.js";
import { openExtensionPage } from "../shared/launch.mjs";
import { CHROMIUM_EXTENSION } from "../shared/launch.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// J11.CH: what Chrome is asked to grant. This pins the BUILT manifest (the artifact people install),
// not the config that produces it. Holds on both lanes.

const FOUR_HOSTS = ["*://*.youtube.com/*", "*://*.instagram.com/*", "*://*.facebook.com/*", "*://*.tiktok.com/*"];

const builtManifest = () => JSON.parse(readFileSync(join(CHROMIUM_EXTENSION, "manifest.json"), "utf8")) as Record<string, unknown>;

test("J11.CH the built manifest asks for exactly storage, alarms and request redirects, on four hosts", () => {
  const manifest = builtManifest();
  expect([...(manifest.permissions as string[])].sort()).toEqual(["alarms", "declarativeNetRequestWithHostAccess", "storage"]);
  expect([...(manifest.host_permissions as string[])].sort()).toEqual([...FOUR_HOSTS].sort());
  expect(manifest.optional_permissions).toBeUndefined();
  expect(manifest.optional_host_permissions).toBeUndefined();
});

test("J11.CH nothing in the built manifest reaches beyond the four services", () => {
  const manifest = builtManifest();
  const text = JSON.stringify(manifest);
  expect(text).not.toContain("<all_urls>");
  expect(text).not.toMatch(/"(tabs|history|webRequest|cookies|activeTab|scripting|webNavigation|bookmarks|downloads)"/);
  const contentScripts = manifest.content_scripts as { matches: string[] }[];
  for (const script of contentScripts) expect([...script.matches].sort()).toEqual([...FOUR_HOSTS].sort());
  const externally = manifest.externally_connectable as unknown;
  expect(externally).toBeUndefined();
});

test("J11.CH the running extension holds exactly what the manifest declares", async ({ context, extensionId, evidence }) => {
  const ev = evidence("J11.CH");
  const page = await openExtensionPage(context, extensionId, "options", { width: 560, height: 900 });
  const granted = await page.evaluate(() => chrome.permissions.getAll());
  ev.log("granted-permissions", granted);
  expect([...(granted.permissions ?? [])].sort()).toEqual(["alarms", "declarativeNetRequestWithHostAccess", "storage"]);
  expect([...(granted.origins ?? [])].sort()).toEqual([...FOUR_HOSTS].sort());
});

test("J11.CH Chrome refuses to let the extension withdraw its own required site access", async ({ context, extensionId }) => {
  // Finding for the site-access-withdrawn screen (D03-11): the withdrawn state cannot be reached
  // through the API. A person reaches it in chrome://extensions, which this harness cannot drive.
  const page = await openExtensionPage(context, extensionId, "options", { width: 560, height: 900 });
  const outcome = await page.evaluate((origins) =>
    chrome.permissions.remove({ origins }).then(
      () => "removed",
      (error: Error) => error.message,
    ), FOUR_HOSTS);
  expect(outcome).toBe("You cannot remove required permissions.");
});

test.fixme("J11.CH site access withdrawn shows the permission-needed state in settings (D03-11)", async () => {
  // Needs Chrome's per-site "on click / on specific sites" control: owner-assisted capture, or a
  // harness that can drive chrome://extensions. See the refusal test above for why the API cannot.
});
