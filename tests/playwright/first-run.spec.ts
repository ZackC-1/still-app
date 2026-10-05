import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, fixture } from "./_extension.js";

const CHROMIUM_EXTENSION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/ext-chromium/dist/chrome-mv3",
);

// D14: the first-run page opens on a brand-new install only, never on an update, and blocking
// never waits for it.

const FIRST_RUN = /^chrome-extension:\/\/[a-z]{32}\/first-run\.html$/;

// The first-run page is a V3 screen: it opens only in builds that show the V3 screens. A configured
// (2.x store-style) build keeps today's install behaviour and its existing settings page.
const syncConfigured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
const V3_ONLY = "First-run is a V3 screen; configured 2.x builds do not open it";

async function firstRunPage(context: BrowserContext): Promise<Page> {
  const open = context.pages().find((page) => FIRST_RUN.test(page.url()));
  if (open) return open;
  return context.waitForEvent("page", { predicate: (page) => FIRST_RUN.test(page.url()), timeout: 15_000 });
}

const firstRunPages = (context: BrowserContext): Page[] =>
  context.pages().filter((page) => FIRST_RUN.test(page.url()));

test("a new install opens the first-run page once, without a combined consent question", async ({
  context,
  extensionId,
}) => {
  test.skip(syncConfigured, V3_ONLY);
  expect(extensionId).toMatch(/^[a-z]{32}$/);
  const page = await firstRunPage(context);
  await page.waitForLoadState("domcontentloaded");
  await expect(page).toHaveTitle("Welcome to Still");
  // Chrome grants the four declared hosts at install and the background saves the defaults.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Still is on.");
  await expect(page.getByText("Allowed on YouTube, Instagram, Facebook and TikTok.")).toBeVisible();
  await expect(page.getByText("Pin Still to your toolbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Still settings" })).toBeEnabled();
  await expect(page.getByText("Share your email and usage data with Still?")).toHaveCount(0);
  expect(firstRunPages(context)).toHaveLength(1);
});

// A real update. A command-line (--load-extension) extension is reported to onInstalled as
// "install" on every browser start, so it cannot stand in for one, and chrome.runtime.reload()
// disables it in this harness. Chrome's own developer loader can: load the unpacked copy (install),
// raise its manifest version, and load the same path again (update), in one running browser.
async function launchWithExtensionLoader(profile: string) {
  const proc = spawn(
    chromium.executablePath(),
    [
      "--headless=new",
      // Playwright's own launcher passes this by default; Linux CI runners refuse to start
      // Chromium's sandbox without it.
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`browser did not start: ${output.slice(0, 500)}`)), 30_000);
    // A browser that dies at startup fails the test at once, not after the 30s wait.
    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`browser exited (${code}) before it started: ${output.slice(0, 500)}`));
    });
    proc.stderr!.on("data", (chunk) => {
      output += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolveEndpoint(match[1]);
      }
    });
  });
  const browser = await chromium.connectOverCDP(endpoint);
  const session = await browser.newBrowserCDPSession();
  return {
    context: browser.contexts()[0],
    load: (path: string) =>
      session.send("Extensions.loadUnpacked" as never, { path } as never) as Promise<{ id: string }>,
    // Waits for the browser process to exit, so its profile is no longer being written when the
    // caller deletes it.
    async close() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise((resolveExit) => proc.once("exit", resolveExit));
      // Ask Chromium to quit so it shuts down its own helper processes, which otherwise keep writing
      // to the profile after the main process is killed.
      await session.send("Browser.close" as never).catch(() => {});
      await browser.close().catch(() => {});
      const terminate = setTimeout(() => proc.kill(), 3_000);
      const forced = setTimeout(() => proc.kill("SIGKILL"), 8_000);
      await exited;
      clearTimeout(terminate);
      clearTimeout(forced);
    },
  };
}

test("an update does not open the first-run page", async () => {
  test.skip(syncConfigured, V3_ONLY);
  test.setTimeout(120_000);
  const work = mkdtempSync(join(tmpdir(), "still-first-run-update-"));
  const extension = join(work, "extension");
  cpSync(CHROMIUM_EXTENSION, extension, { recursive: true });
  let browser: Awaited<ReturnType<typeof launchWithExtensionLoader>> | undefined;
  try {
    browser = await launchWithExtensionLoader(join(work, "profile"));
    const { context } = browser;
    const installed = firstRunPage(context);
    const { id } = await browser.load(extension);
    const first = await installed;
    expect(first.url()).toBe(`chrome-extension://${id}/first-run.html`);
    await first.close();

    const manifestPath = join(extension, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string };
    const updatedVersion = manifest.version.replace(/\d+$/, (n) => String(Number(n) + 1));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: updatedVersion }));
    expect((await browser.load(extension)).id).toBe(id);

    // Proof the browser took the update before the quiet window starts.
    const probe = await context.newPage();
    await expect
      .poll(
        async () => {
          await probe.goto(`chrome-extension://${id}/options.html`).catch(() => null);
          return probe.evaluate(() => chrome.runtime.getManifest().version).catch(() => null);
        },
        { timeout: 15_000 },
      )
      .toBe(updatedVersion);
    await probe.close();
    await new Promise((resolveQuiet) => setTimeout(resolveQuiet, 3_000));
    expect(firstRunPages(context)).toHaveLength(0);
  } finally {
    await browser?.close();
    // Best-effort cleanup of a throwaway temp folder; it must not fail a test that passed.
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      console.warn(`could not remove ${work}: ${String(error)}`);
    }
  }
});

test("blocking works on a fresh install without ever looking at the first-run page", async ({ context }) => {
  if (!syncConfigured) await (await firstRunPage(context)).close();
  const page = await context.newPage();
  await page.route("**://*.youtube.com/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture("youtube.html") }),
  );
  await page.goto("https://www.youtube.com/feed/subscriptions");
  await expect(page.locator("#shelf")).toHaveCount(0);
  await expect(page.locator("#rich-shorts-section")).toHaveCount(0);
});

test("Settings → Setup guide reopens the first-run page", async ({ context, extensionId }) => {
  test.skip(syncConfigured, V3_ONLY);
  const setup = await firstRunPage(context);
  await setup.close();
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const reopened = context.waitForEvent("page", { predicate: (page) => FIRST_RUN.test(page.url()) });
  await options.getByRole("button", { name: "Setup guide" }).click();
  const page = await reopened;
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Still is on.");
});

test("a configured store-style build does not open the first-run page on install", async ({ context, extensionId }) => {
  test.skip(!syncConfigured, "Requires the independently declared configured build");
  expect(extensionId).toMatch(/^[a-z]{32}$/);
  await new Promise((resolveQuiet) => setTimeout(resolveQuiet, 3_000));
  expect(firstRunPages(context)).toHaveLength(0);
});
