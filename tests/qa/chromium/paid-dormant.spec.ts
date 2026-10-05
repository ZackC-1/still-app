import { test, expect } from "../shared/fixtures.js";
import { FIRST_RUN, serveFixture } from "../shared/serve.js";
import { openExtensionPage, readStore, waitForCommittedSettings } from "../shared/launch.mjs";
import { syncConfigured } from "../shared/lane.js";
import { offersPurchase } from "../../playwright/_extras-helpers.js";
import type { Page } from "@playwright/test";

// J12.CH: both paid flags are off, so no screen Still shows may offer a purchase (owner decision 6),
// locked Pro rows offer nothing when tapped (decision 24), and the browser never makes a checkout,
// RevenueCat or sales request. Holds on both lanes: the configured build is where the purchase
// pieces actually exist.

const SALES_REQUEST = /revenuecat|rc-?billing|stripe|checkout|paddle|purchase|product-policy|entitlement|storekit/i;

async function expectNoOffer(page: Page, where: string): Promise<void> {
  await page.waitForTimeout(600); // late-rendering cards
  const visible = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const all = (await page.locator("body").evaluate((b) => b.textContent ?? "")).replace(/\s+/g, " ");
  expect(offersPurchase(visible), `${where}: visible text offers a purchase: ${visible}`).toBe(false);
  expect(offersPurchase(all), `${where}: page text offers a purchase`).toBe(false);
  const controls = await page.locator("button, a, [role='button'], [role='link']").evaluateAll((nodes) =>
    nodes.map((n) => `${n.textContent ?? ""} ${n.getAttribute("aria-label") ?? ""} ${n.getAttribute("href") ?? ""}`.replace(/\s+/g, " ").trim()),
  );
  for (const label of controls) expect(offersPurchase(label), `${where}: control "${label}"`).toBe(false);
  // No link or button may lead off the extension to a payment page.
  const hrefs = await page.locator("a[href]").evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).href));
  for (const href of hrefs) expect(href, `${where}: link ${href}`).not.toMatch(SALES_REQUEST);
}

async function expandEvery(page: Page, where: string, evidenceShot: (step: string) => Promise<void>): Promise<void> {
  for (const service of ["YouTube", "Instagram", "Facebook"]) {
    const header = page.getByRole("button", { name: new RegExp(`^${service} Blocker`) });
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expectNoOffer(page, `${where} with ${service} open`);
    await evidenceShot(`${where}-${service.toLowerCase()}-open`);
  }
}

test("J12.CH no popup, options, first-run or TikTok page state offers a purchase", async ({
  context,
  extensionId,
  network,
  evidence,
}) => {
  test.setTimeout(90_000);
  const ev = evidence("J12.CH");
  if (!syncConfigured) await waitForCommittedSettings(context);

  for (const name of ["popup", "options"] as const) {
    const page = await openExtensionPage(context, extensionId, name, { width: name === "popup" ? 380 : 560, height: 900 });
    await expect(page.getByRole("switch").first()).toBeVisible();
    await expectNoOffer(page, `${name} (collapsed)`);
    await ev.shot(page, `${name}-collapsed`);
    await expandEvery(page, name, (step) => ev.shot(page, step));
    await page.close();
  }

  if (!syncConfigured) {
    const firstRun =
      context.pages().find((p) => FIRST_RUN.test(p.url())) ??
      (await openExtensionPage(context, extensionId, "first-run", { width: 600, height: 900 }));
    await expectNoOffer(firstRun, "first-run");
    await ev.shot(firstRun, "first-run");

    // The TikTok page and its confirmation, reached the way a person reaches it.
    await serveFixture(context, "**://*.tiktok.com/**", "tiktok.html");
    const tiktok = await context.newPage();
    await tiktok.goto("https://www.tiktok.com/foryou", { waitUntil: "commit" });
    await tiktok.waitForURL(/tiktok-blocked\.html/, { waitUntil: "commit" });
    await expect(tiktok.getByRole("heading", { name: "TikTok stays closed." })).toBeVisible();
    await expectNoOffer(tiktok, "tiktok blocked page");
    await ev.shot(tiktok, "tiktok-blocked");
    await tiktok.getByRole("button", { name: "Open TikTok this time" }).click();
    await expect(tiktok.getByRole("dialog")).toBeVisible();
    await expectNoOffer(tiktok, "tiktok confirmation");
    await ev.shot(tiktok, "tiktok-confirmation");
  }

  const sales = network.entries.filter((entry) => SALES_REQUEST.test(`${entry.origin}${entry.path}`));
  ev.log("network-log", network.entries);
  expect(sales, "no checkout, RevenueCat or sales request was made").toEqual([]);
});

test("J12.CH locked Pro rows show the lock and Still Pro, and offer nothing when tapped", async ({
  context,
  extensionId,
  network,
  evidence,
}) => {
  test.skip(syncConfigured, "Rows are checked on the V3 lane; the configured lane is covered by extras-ui-dormancy");
  const ev = evidence("J12.CH");
  await waitForCommittedSettings(context);
  const before = JSON.stringify(await readStore(context, "still:settings"));
  const pagesBefore = context.pages().length;
  const requestsBefore = network.entries.length;

  const page = await openExtensionPage(context, extensionId, "options", { width: 560, height: 900 });
  // The 12 extras by service, as the registry spells them.
  const rows = {
    YouTube: ["Related videos", "End-of-video suggestions", "Autoplay prevention", "Comments", "Live chat"],
    Instagram: ["Explore recommendations", "Stories and Highlights", "Suggested accounts", "Threads links"],
    Facebook: ["Facebook Stories", "Videos and Watch", "Desktop sidebar ads"],
  };
  let tapped = 0;
  for (const [service, names] of Object.entries(rows)) {
    const header = page.getByRole("button", { name: new RegExp(`^${service} Blocker`) });
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    for (const name of names) {
      const row = page.locator(".option-row").filter({ has: page.locator(".label", { hasText: new RegExp(`^${name}$`) }) });
      await expect(row, `${name} is shown`).toHaveCount(1);
      await expect(row, `${name} shows the lock and Still Pro`).toContainText("Still Pro");
      // The only control is the lock chip, and it is inert (aria-disabled, no action behind it).
      await expect(row.locator('[role="switch"], input[type="checkbox"]'), `${name} has no switch`).toHaveCount(0);
      const lock = row.locator("button.lock-pro");
      await expect(lock, `${name} has one lock chip`).toHaveCount(1);
      await expect(lock, `${name} lock chip is inert`).toHaveAttribute("aria-disabled", "true");
      await row.click({ force: true });
      await lock.click({ force: true });
      tapped += 1;
    }
    await ev.shot(page, `locked-rows-${service.toLowerCase()}`);
  }
  expect(tapped, "all 12 locked rows were tapped").toBe(12);
  await page.waitForTimeout(800);
  expect(context.pages().length, "tapping opened no page").toBe(pagesBefore + 1);
  expect(JSON.stringify(await readStore(context, "still:settings")), "tapping changed no saved choice").toBe(before);
  expect(network.entries.length, "tapping made no request").toBe(requestsBefore);
  await expectNoOffer(page, "options after tapping locked rows");
});
