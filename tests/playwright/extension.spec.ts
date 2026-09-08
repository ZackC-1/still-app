import { test, expect } from "./_extension.js";

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
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 600 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => document.fonts.ready);

  const layout = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    zoom: getComputedStyle(document.documentElement).zoom,
  }));

  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
  expect(layout.zoom).toBe("1");

  // Vertically, a popup is allowed to scroll: the browser caps it at 600px and scrolls the rest,
  // and whether the content happens to fit under that cap depends on the installed fonts and on
  // the current wording, neither of which this test owns. What must hold is that nothing is out of
  // reach. So scroll to the bottom control and require all of it to be visible, rather than
  // asserting a total height that measures 600px on one machine and 610px on another.
  const openSettings = page.getByRole("button", {
    // Substring match on the stable visible label — the surface-specific aria-label suffix may change.
    name: "Open settings & setup guide",
  });
  await openSettings.scrollIntoViewIfNeeded();
  await expect(openSettings).toBeInViewport({ ratio: 1 });
});

// The same popup document is Safari's extension sheet on iPhone, where it gets the device width
// rather than a width of its own choosing. 375pt (iPhone SE, mini, 8) and 320pt (the original SE,
// the narrowest screen the iOS 15 deployment target still reaches) are both narrower than the
// popup's 380px, and the popup does not scroll sideways: whatever overhangs is simply unreachable.
// A viewport of that width is the faithful stand-in, because unlike a desktop toolbar popup an
// extension sheet has a real viewport handed to it.
for (const width of [375, 320]) {
  test(`the popup fits a ${width}px surface with every switch reachable`, async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 640 });
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
          (element) =>
            element.getBoundingClientRect().right <= available + 0.5,
        ),
      };
    });

    expect(fit.popupWidth).toBeLessThanOrEqual(fit.available);
    expect(fit.clippedCount).toBe(0);
    expect(fit.switchCount).toBeGreaterThan(0);
    expect(fit.switchesFullyVisible).toBe(true);
  });
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
