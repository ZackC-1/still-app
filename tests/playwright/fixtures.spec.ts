import { test, expect, fixture } from "./_extension.js";
import type { Page } from "@playwright/test";

// Serve a service's fixture HTML for every request to its domain (no real network); the extension's
// content script injects because the committed URL matches its host pattern.
async function serve(page: Page, domainGlob: string, html: string): Promise<void> {
  await page.route(domainGlob, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
}

test("youtube: removes the Shorts shelf + hides the sidebar entry, keeps real content", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.youtube.com/**", fixture("youtube.html"));
  await page.goto("https://www.youtube.com/feed/subscriptions");

  await expect(page.locator("#shelf")).toHaveCount(0); // remove surface
  await expect(page.locator("#keep-video")).toBeVisible(); // real content intact
  await expect(page.locator("#endpoint")).toBeHidden(); // hide surface (still-active CSS / applyDom)
  await expect(page.locator("html")).toHaveClass(/still-active/);
});

test("youtube: a Shorts URL ends up on the watch page (redirect)", async ({ context }) => {
  const page = await context.newPage();
  await page.route("**://*.youtube.com/**", (route) => {
    const url = route.request().url();
    const body = url.includes("/watch") ? "<!doctype html><title>watch</title>watch" : fixture("youtube.html");
    return route.fulfill({ contentType: "text/html; charset=utf-8", body });
  });
  await page.goto("https://www.youtube.com/shorts/abc123");
  await expect(page).toHaveURL(/\/watch\?v=abc123/);
});

test("instagram: removes an inline Reel + hides the Reels nav, keeps a normal post", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.instagram.com/**", fixture("instagram.html"));
  await page.goto("https://www.instagram.com/someuser/");

  await expect(page.locator("#reel-post")).toHaveCount(0);
  await expect(page.locator("#keep-post")).toBeVisible();
  await expect(page.locator("#reels-link")).toBeHidden();
});

test("facebook: removes a Reel article + hides the Reels shortcut, keeps a normal post", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook.html"));
  await page.goto("https://www.facebook.com/");

  await expect(page.locator("#reel-article")).toHaveCount(0);
  await expect(page.locator("#keep-article")).toBeVisible();
  await expect(page.locator("#reels-shortcut")).toBeHidden();
});

test("tiktok: the whole site is replaced by the Still placeholder", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.tiktok.com/**", fixture("tiktok.html"));
  await page.goto("https://www.tiktok.com/foryou");

  await expect(page.locator("#still-placeholder")).toBeVisible();
  await expect(page.locator("#tiktok-feed")).toHaveCount(0);
});
