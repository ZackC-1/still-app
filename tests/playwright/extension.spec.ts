import type { BrowserContext } from "@playwright/test";
import { test, expect } from "./_extension.js";

// The real geometry of a browser-action popup, used both as the viewport and as the thresholds
// asserted below so the contract is stated once. Chrome and Firefox both refuse to show a popup
// taller than 600px and scroll the remainder; Still asks for 380px of the available width.
const POPUP_INLINE_SIZE = 380;
const POPUP_MAX_BLOCK_SIZE = 600;
// CI supplies this independently of the build inputs. Assert the rendered capability so a stale
// unconfigured bundle cannot silently satisfy the configured geometry gate.
const syncConfigured = process.env.STILL_TEST_SYNC_CONFIGURED;

test("the background service worker registers and yields an extension id", async ({
  extensionId,
}) => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
});

test("the options page renders the four service cards", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator("[data-service]")).toHaveCount(4);
});

test("the popup keeps every primary control visible without scaling or overflow", async ({
  context,
  extensionId,
}) => {
  await context.route(/^https?:/, (route) => route.abort());
  const page = await context.newPage();
  await page.setViewportSize({
    width: POPUP_INLINE_SIZE,
    height: POPUP_MAX_BLOCK_SIZE,
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => document.fonts.ready);

  if (syncConfigured !== undefined) {
    await expect(
      page.getByRole("button", { name: "Sign in to sync", exact: true }),
    ).toHaveCount(syncConfigured === "true" ? 1 : 0);
  }
  await expect(page.getByRole("switch")).toHaveCount(5);

  const layout = await page.evaluate(() => {
    // The furthest bottom edge anything is laid out at, measured from the top of the document.
    // Clipping does not move boxes, so this still sees content that `overflow: clip` has hidden.
    const bottoms = [...document.body.querySelectorAll("*")].map((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 || box.height > 0 ? box.bottom + window.scrollY : 0;
    });
    return {
      scrollY: window.scrollY,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      contentBottom: Math.ceil(Math.max(0, ...bottoms)),
      zoom: getComputedStyle(document.documentElement).zoom,
    };
  });

  // The viewport really is the popup's box, so the limits below mean what they say. Without this
  // a future viewport change could quietly make every height assertion unfalsifiable.
  expect(layout.innerWidth).toBe(POPUP_INLINE_SIZE);
  expect(layout.innerHeight).toBe(POPUP_MAX_BLOCK_SIZE);

  expect(layout.scrollY).toBe(0);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
  expect(layout.zoom).toBe("1");

  // Height is asserted two ways, because either measure alone can be satisfied by a popup the user
  // cannot actually use:
  //   - the document's scroll height catches the popup outgrowing the 600px a browser will show,
  //     which is the ordinary way this breaks (longer copy, another card, a taller control);
  //   - the furthest laid-out edge catches the opposite mistake, pinning the popup's height and
  //     letting `overflow: clip` swallow the surplus, which the first measure reports as a clean
  //     600 while the content below is both invisible and unreachable.
  // The configured sign-in card is taller than the device-only card; both must fit on initial open.
  expect(layout.scrollHeight).toBeLessThanOrEqual(POPUP_MAX_BLOCK_SIZE);
  expect(layout.contentBottom).toBeLessThanOrEqual(POPUP_MAX_BLOCK_SIZE);

  // Substring match on the stable visible label: the surface-specific aria-label suffix may change.
  // No scrolling first, so this asserts the control is wholly visible in the popup as it opens.
  await expect(
    page.getByRole("button", { name: "Open settings & setup guide" }),
  ).toBeInViewport({ ratio: 1 });
});

// The same popup document is Safari's extension sheet on iPhone, where it gets the device width
// rather than a width of its own choosing. 375pt (iPhone SE, mini, 8) and 320pt (the original SE,
// the narrowest screen the iOS 15 deployment target still reaches) are both narrower than the
// popup's 380px, and the popup does not scroll sideways: whatever overhangs is simply unreachable.
// A viewport of that width is the faithful stand-in, because unlike a desktop toolbar popup an
// extension sheet has a real viewport handed to it.
async function expectPopupFits(
  context: BrowserContext,
  extensionId: string,
  width: number,
  colorScheme: "light" | "dark",
): Promise<void> {
  const page = await context.newPage();
  await context.route(/^https?:/, (route) => route.abort());
  await page.setViewportSize({ width, height: 640 });
  await page.emulateMedia({ colorScheme });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => document.fonts.ready);

  const fit = await page.evaluate(() => {
    const available = document.documentElement.clientWidth;
    const clipped = [...document.querySelectorAll("*")].filter((element) => {
      const box = element.getBoundingClientRect();
      // Half a pixel of tolerance: sub-pixel text metrics, not a layout fault.
      return box.width > 0 && box.right > available + 0.5;
    });
    const switches = [...document.querySelectorAll('button[role="switch"]')];
    return {
      available,
      popupWidth: Math.round(
        document.querySelector(".popup")!.getBoundingClientRect().width,
      ),
      clippedCount: clipped.length,
      switchCount: switches.length,
      switchesFullyVisible: switches.every(
        (element) => element.getBoundingClientRect().right <= available + 0.5,
      ),
    };
  });

  expect(fit.popupWidth).toBeLessThanOrEqual(fit.available);
  expect(fit.clippedCount).toBe(0);
  expect(fit.switchCount).toBe(5);
  expect(fit.switchesFullyVisible).toBe(true);

  // Reach every interactive control using the keyboard, including the final settings button.
  const controls = page.locator(
    'button:not([disabled]):not([tabindex="-1"]), a[href]',
  );
  for (let index = 0; index < (await controls.count()); index++) {
    await page.keyboard.press("Tab");
    await expect(controls.nth(index)).toBeFocused();
    await expect(controls.nth(index)).toBeInViewport({ ratio: 1 });
  }
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 320]) {
    test(`the Chromium build's popup fits a ${width}px ${colorScheme} surface with every switch reachable`, async ({
      context,
      extensionId,
    }) => {
      await expectPopupFits(context, extensionId, width, colorScheme);
    });

    // The bug that prompted these checks is an iPhone one, and the iPhone runs the Safari build,
    // which carries its own popup copy. Blink renders it here, so this proves the Safari bundle's
    // markup and stylesheet fit a narrow screen; it does not stand in for WebKit or for how a real
    // Safari popover or iOS sheet hosts the document.
    test(`the Safari build's popup fits a ${width}px ${colorScheme} surface with every switch reachable`, async ({
      safariContext,
      safariExtensionId,
    }) => {
      await expectPopupFits(
        safariContext,
        safariExtensionId,
        width,
        colorScheme,
      );
    });
  }
}

test("the manifest limits host permissions to the four services (no <all_urls>)", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/manifest.json`);
  const manifest = JSON.parse(await page.locator("body").innerText()) as {
    host_permissions: string[];
  };
  expect(manifest.host_permissions).toHaveLength(4);
  expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`signed-in account status fits the configured popup in ${colorScheme} mode`, async ({ context, extensionId }) => {
    test.skip(syncConfigured !== "true", "Requires the independently declared configured build");
    await context.route(/^https?:/, (route) => route.abort());
    const page = await context.newPage();
    await page.setViewportSize({ width: POPUP_INLINE_SIZE, height: POPUP_MAX_BLOCK_SIZE });
    await page.emulateMedia({ colorScheme });
    const email = "a.long.account.name.for.layout.testing@example.com";
    await page.addInitScript(({ email }) => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = ((message: { kind?: string; action?: string }, ...args: unknown[]) => {
        if (message.kind === "still:session" && message.action === "getSyncStatus") {
          return Promise.resolve({ accountId: "11111111-1111-1111-1111-111111111111", email,
            lastSyncedAt: Date.now(), pendingUpload: false, cloudReachable: true, updatedAt: Date.now() });
        }
        return Reflect.apply(send, chrome.runtime, [message, ...args]);
      }) as typeof chrome.runtime.sendMessage;
    }, { email });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await expect(page.getByText("Synced with your account.", { exact: true })).toBeVisible();
    const fit = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      bottom: Math.ceil(Math.max(...[...document.body.querySelectorAll("*")].map((el) => el.getBoundingClientRect().bottom))),
    }));
    expect(fit.width).toBeLessThanOrEqual(POPUP_INLINE_SIZE);
    expect(fit.height).toBeLessThanOrEqual(POPUP_MAX_BLOCK_SIZE);
    expect(fit.bottom).toBeLessThanOrEqual(POPUP_MAX_BLOCK_SIZE);
    await expect(page.getByRole("button", { name: "Open settings & setup guide" })).toBeInViewport({ ratio: 1 });
  });
}
