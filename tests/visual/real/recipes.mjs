// State recipes for the real-extension visual runner (T1). Each recipe gets a fresh Chromium
// profile with the built extension and returns the page to screenshot. States are reached through
// real UI input, real storage written from the extension's own context, and real browser APIs
// called from an extension page. (Site-access withdrawal is not among them: Chrome refuses
// chrome.permissions.remove for required host permissions, so those frames are BLOCKED.) Nothing here changes product code or adds a product hook.
import { openExtensionPage } from "../../qa/shared/launch.mjs";

const settle = (page, ms = 600) => page.waitForTimeout(ms);

/** A state this build cannot reach (not a failure of the product or the harness); reported as BLOCKED. */
export class Blocked extends Error {}

/** Open the YouTube section the way a person does: click its expander, then park the pointer. */
async function expandYouTube(page) {
  await page.getByRole("button", { name: /YouTube Blocker/ }).click();
  await page.mouse.move(0, 0);
  await settle(page, 300);
}

/** Tab from the top of the document until the element the matcher accepts has real keyboard focus. */
async function tabTo(page, matches, what) {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(matches)) return;
  }
  throw new Error(`Tab never reached ${what}`);
}

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
  // The reference shows the YouTube section open (d01-05).
  "popup-still-off-expanded": async (ctx) => {
    const page = await recipes["popup-still-off"](ctx);
    await expandYouTube(page);
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
  // d03-01 shows the YouTube section open.
  "options-fresh-expanded": async (ctx) => {
    const page = await recipes["options-fresh"](ctx);
    await expandYouTube(page);
    return page;
  },
  // d03-10 is a photograph of the open YouTube card with 12 CSS px around it, not of the page top:
  // scroll the page (as a person would) so the card, less that margin, is at the top of the frame.
  "options-still-off-youtube-card": async (ctx) => {
    const page = await recipes["options-still-off"](ctx);
    await expandYouTube(page);
    await page.evaluate(() => {
      const card = document.querySelector(".site-section");
      window.scrollTo(0, window.scrollY + card.getBoundingClientRect().top - 12);
    });
    await settle(page, 300);
    return page;
  },
  // d03-14: real keyboard focus on Sign in. The frame needs a build with sign-in compiled in
  // (the lane tells the recipe: `signIn`). Without it the frame is BLOCKED; with it, a Sign in
  // that is disabled or unreachable is a FAIL, never a BLOCKED.
  "options-focus-sign-in": async ({ context, id, size, signIn }) => {
    if (!signIn) throw new Blocked("needs a build with sign-in compiled in (no Supabase URL and key in this build)");
    const page = await openExtensionPage(context, id, "options", size);
    await settle(page);
    if (await page.getByRole("button", { name: "Sign in", exact: true }).isDisabled())
      throw new Error("Sign in is disabled although this build has sign-in compiled in");
    await tabTo(page, () => document.activeElement?.textContent?.trim() === "Sign in", "Sign in");
    await page.mouse.move(0, 0);
    await settle(page, 300);
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
    // Opened from the keyboard, as the reference shows (the focus ring on "Keep it closed" only
    // draws after keyboard input); a mouse click leaves :focus-visible off.
    await tabTo(page, () => document.activeElement?.textContent?.trim() === "Open TikTok this time", "Open TikTok this time");
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    await page.mouse.move(0, 0);
    await settle(page);
    return page;
  },
};
