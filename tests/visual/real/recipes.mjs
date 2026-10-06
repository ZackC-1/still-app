// State recipes for the real-extension visual runner (T1). Each recipe gets a fresh Chromium
// profile with the built extension and returns the page to screenshot. States are reached through
// real UI input, real storage written from the extension's own context, and real browser APIs
// called from an extension page. (Site-access withdrawal is not among them: Chrome refuses
// chrome.permissions.remove for required host permissions, so those frames are BLOCKED.) Nothing here changes product code or adds a product hook.
import { openExtensionPage } from "../../qa/shared/launch.mjs";

const settle = (page, ms = 600) => page.waitForTimeout(ms);

export const recipes = {
  "popup-fresh": async ({ context, id, size }) => {
    const page = await openExtensionPage(context, id, "popup", size);
    await settle(page);
    return page;
  },
  "popup-still-off": async ({ context, id, size }) => {
    const page = await openExtensionPage(context, id, "popup", size);
    await page.getByRole("switch").first().click();
    await page.mouse.move(0, 0);
    await settle(page);
    return page;
  },
  "popup-focus-youtube-expander": async ({ context, id, size }) => {
    const page = await openExtensionPage(context, id, "popup", size);
    // Real keyboard focus: Tab from the top of the document until the YouTube expander has it.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const reached = await page.evaluate(
        () => /youtube/i.test(document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "") &&
          document.activeElement?.hasAttribute("aria-expanded"),
      );
      if (reached) {
        await settle(page, 300);
        return page;
      }
    }
    throw new Error("Tab never reached the YouTube expander");
  },
  "options-fresh": async ({ context, id, size }) => {
    const page = await openExtensionPage(context, id, "options", size);
    await settle(page);
    return page;
  },
  "options-still-off": async ({ context, id, size }) => {
    const page = await openExtensionPage(context, id, "options", size);
    await page.getByRole("switch").first().click();
    await page.mouse.move(0, 0);
    await settle(page);
    return page;
  },
  "firstrun-fresh": async ({ context, id, size }) => {
    const page = await openExtensionPage(context, id, "first-run", size);
    await settle(page);
    return page;
  },
  // The TikTok page, reached the way a person reaches it: open TikTok (a fixture answers the
  // request), the extension redirects the tab to its own blocked page.
  "tiktok-blocked": async ({ context, size }) => {
    await context.route("**://*.tiktok.com/**", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: "<h1>fixture</h1>" }),
    );
    const page = await context.newPage();
    await page.setViewportSize(size);
    await page.goto("https://www.tiktok.com/foryou", { waitUntil: "commit" });
    await page.waitForURL(/^chrome-extension:\/\/[a-p]{32}\/tiktok-blocked\.html/, { waitUntil: "commit" });
    await page.getByRole("heading", { name: "TikTok stays closed." }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await settle(page);
    return page;
  },
  "tiktok-confirmation": async (ctx) => {
    const page = await recipes["tiktok-blocked"](ctx);
    await page.getByRole("button", { name: "Open TikTok this time" }).click();
    await page.getByRole("dialog").waitFor();
    await page.mouse.move(0, 0);
    await settle(page);
    return page;
  },
};
