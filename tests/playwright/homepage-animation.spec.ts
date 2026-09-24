import { test, expect, type Page } from '@playwright/test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs');
const homepage = 'https://still.test/';

async function serveWebsite(page: Page) {
  await page.route(`${homepage}**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({ path: resolve(docs, `.${pathname === '/' ? '/index.html' : pathname}`) });
  });
}

async function frameImage(page: Page) {
  return page.locator('.hero-animation').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
}

test.describe('homepage animation', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test.beforeEach(async ({ page }) => {
    await serveWebsite(page);
    const start = new Date('2026-09-24T00:00:00Z');
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start);
    await page.goto(homepage);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.hero-animation')).toBeVisible();
    await page.clock.runFor(100);
  });

  test('rushes, freezes, clears to blue, then repeats', async ({ page }) => {
    await page.clock.runFor(1300);
    const rushing = await frameImage(page);
    await page.clock.runFor(3400);
    const stopped = await frameImage(page);
    expect(stopped).not.toBe(rushing);
    await page.clock.runFor(200);
    expect(await frameImage(page)).toBe(stopped);
    await page.clock.runFor(2000);
    const calm = await frameImage(page);
    expect(calm).not.toBe(stopped);
    expect(await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) =>
      [...canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data],
    )).toEqual([33, 65, 237, 255]);
    await page.clock.runFor(1000);
    expect(await frameImage(page)).toBe(calm);
    await page.clock.runFor(3800);
    expect(await frameImage(page)).not.toBe(calm);
  });

  test('can be paused and resumed with the keyboard', async ({ page }) => {
    await page.clock.runFor(1000);
    await page.getByRole('button', { name: 'Pause animation' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Play animation' })).toBeFocused();
    const paused = await frameImage(page);
    await page.clock.runFor(2000);
    expect(await frameImage(page)).toBe(paused);
    await page.keyboard.press('Enter');
    await page.clock.runFor(500);
    expect(await frameImage(page)).not.toBe(paused);
  });

  test('reduced motion stays calm, including preference changes', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.hero-animation-toggle')).toBeHidden();
    const still = await frameImage(page);
    await page.clock.runFor(12000);
    expect(await frameImage(page)).toBe(still);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.getByRole('button', { name: 'Pause animation' })).toBeVisible();
    await page.clock.runFor(500);
    expect(await frameImage(page)).not.toBe(still);
  });

  test('suspends while offscreen and resumes on return', async ({ page }) => {
    await page.clock.runFor(1000);
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
    await expect(page.locator('canvas')).not.toBeInViewport();
    await page.clock.runFor(100);
    const offscreen = await frameImage(page);
    await page.clock.runFor(2000);
    expect(await frameImage(page)).toBe(offscreen);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(page.locator('canvas')).toBeInViewport();
    await page.clock.runFor(500);
    expect(await frameImage(page)).not.toBe(offscreen);
  });

  test('keeps its aspect ratio and touch control on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.locator('.hero-media').scrollIntoViewIfNeeded();
    const frame = await page.locator('.hero-media').boundingBox();
    expect(frame!.width / frame!.height).toBeCloseTo(16 / 9, 1);
    const button = await page.getByRole('button', { name: 'Pause animation' }).boundingBox();
    expect(button!.height).toBeGreaterThanOrEqual(44);
    expect(button!.width).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  });
});

test('homepage retains its poster without JavaScript', async ({ browser }) => {
  const page = await browser.newPage({ javaScriptEnabled: false });
  try {
    await serveWebsite(page);
    await page.goto(homepage);
    await expect(page.locator('.hero-video')).toBeVisible();
    await expect(page.locator('.hero-animation')).toBeHidden();
    await expect(page.locator('.hero-animation-toggle')).toBeHidden();
  } finally {
    await page.close();
  }
});

test('homepage keeps its poster if a platform logo cannot load', async ({ page }) => {
  await serveWebsite(page);
  await page.route(`${homepage}assets/platforms/tiktok.svg`, route => route.abort());
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(homepage);
  await expect(page.locator('.hero-video')).toBeVisible();
  await expect(page.locator('.hero-animation')).toBeHidden();
  await expect(page.locator('.hero-animation-toggle')).toBeHidden();
  expect(errors).toEqual([]);
});
