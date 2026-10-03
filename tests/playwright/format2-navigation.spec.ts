import { test, expect } from "./_format2-extension";
import type { Page, Worker } from "@playwright/test";

const ORIGIN = "https://www.youtube.com/results?search_query=fixture";
const SHORTS = "https://www.youtube.com/shorts/fixture";
const WATCH = "https://www.youtube.com/watch?v=fixture";
const html = `<!doctype html><html><head><title>Navigation fixture</title></head><body>
  <div class="shorts" id="owned">Owned hidden surface</div>
  <a id="normal" href="${SHORTS}">Open Shorts</a>
  <a id="download" href="${SHORTS}" download>Download</a>
  <a id="blank" href="${SHORTS}" target="_blank">Other target</a>
  <a id="self" href="${SHORTS}" target="_self">Same target</a>
  <script>window.observed=[];
  document.addEventListener('click',event=>{
    window.observed.push({type:event.type,trusted:event.isTrusted});event.preventDefault();
  });
  document.addEventListener('contextmenu',event=>{
    window.observed.push({type:event.type,trusted:event.isTrusted});event.preventDefault();
  });
  document.addEventListener('keydown',event=>{if(event.key==='Enter'){
    window.observed.push({type:event.type,trusted:event.isTrusted});event.preventDefault();
  }});</script></body></html>`;

async function start(page: Page) {
  const blockedRequests: string[] = [];
  await page.context().route("**/*", (route) => {
    const request = route.request();
    if (
      request.isNavigationRequest() &&
      new URL(request.url()).hostname === "www.youtube.com"
    ) {
      if (new URL(request.url()).pathname.startsWith("/shorts/"))
        blockedRequests.push(request.url());
      return route.fulfill({ contentType: "text/html", body: html });
    }
    return route.abort();
  });
  await page.goto(ORIGIN);
  await expect(page.locator("#owned")).toBeHidden();
  return blockedRequests;
}
const observed = (page: Page) =>
  page.evaluate(() => (window as unknown as { observed: unknown[] }).observed);
async function setEnabled(worker: Worker, enabled: boolean) {
  await worker.evaluate(async (enabled) => {
    const authority = (
      globalThis as unknown as {
        fixtureAuthority: {
          commitIntent: (intent: unknown) => Promise<unknown>;
        };
      }
    ).fixtureAuthority;
    await authority.commitIntent({
      path: "sites.youtube.shorts",
      value: enabled,
      updatedAt: Date.now(),
    });
  }, enabled);
}

for (const action of ["click", "Enter"] as const) {
  test(`format2 trusted ${action} normalizes before commit and Back preserves origin`, async ({
    page,
  }) => {
    const blocked = await start(page);
    if (action === "click") await page.locator("#normal").click();
    else {
      await page.locator("#normal").focus();
      await page.keyboard.press("Enter");
    }
    await expect(page).toHaveURL(WATCH);
    expect(blocked).toEqual([]);
    await page.goBack();
    await expect(page).toHaveURL(ORIGIN);
  });
}

test("format2 rejects synthetic events and preserves modifier/download/non-self exceptions", async ({
  page,
}) => {
  const blocked = await start(page);
  await page.locator("#normal").dispatchEvent("click");
  await page.locator("#normal").dispatchEvent("keydown", { key: "Enter" });
  await expect
    .poll(() => observed(page))
    .toEqual([
      { type: "click", trusted: false },
      { type: "keydown", trusted: false },
    ]);
  for (const modifier of ["Alt", "Control", "Meta", "Shift"] as const)
    await page.locator("#normal").click({ modifiers: [modifier] });
  await page.locator("#download").click();
  await page.locator("#blank").click();
  await expect.poll(() => observed(page)).toHaveLength(8);
  expect(await observed(page)).toEqual([
    { type: "click", trusted: false },
    { type: "keydown", trusted: false },
    { type: "click", trusted: true },
    // Chromium on macOS turns Control-click into a native context-menu event.
    {
      type: process.platform === "darwin" ? "contextmenu" : "click",
      trusted: true,
    },
    ...Array.from({ length: 4 }, () => ({ type: "click", trusted: true })),
  ]);
  await expect(page).toHaveURL(ORIGIN);
  expect(blocked).toEqual([]);
  await page.locator("#self").click();
  await expect(page).toHaveURL(WATCH);
});

test("format2 actual atomic Off/re-enable updates interception; stop removes hooks and late effects", async ({
  page,
  authority,
}) => {
  const blocked = await start(page);
  await setEnabled(authority, false);
  await expect(page.locator("#owned")).toBeVisible();
  await page.locator("#normal").click();
  await expect(page).toHaveURL(ORIGIN);
  await expect
    .poll(() => observed(page))
    .toEqual([{ type: "click", trusted: true }]);
  await setEnabled(authority, true);
  await expect(page.locator("#owned")).toBeHidden();
  await authority.evaluate(async () => {
    const chromeApi = (
      globalThis as unknown as {
        chrome: {
          tabs: {
            query: (q: unknown) => Promise<{ id: number }[]>;
            sendMessage: (id: number, m: unknown) => Promise<unknown>;
          };
        };
      }
    ).chrome;
    const tabs = await chromeApi.tabs.query({
      url: "https://www.youtube.com/*",
    });
    for (const tab of tabs)
      await chromeApi.tabs.sendMessage(tab.id, { kind: "fixture.stop" });
  });
  await expect(page.locator("#owned")).toBeVisible();
  await page.locator("#normal").click();
  await setEnabled(authority, false);
  await setEnabled(authority, true);
  // Observe beyond the media quieting interval after late committed settings events.
  await page.waitForTimeout(150);
  await expect.poll(() => observed(page)).toHaveLength(2);
  await expect(page.locator("#owned")).toBeVisible();
  await expect(page).toHaveURL(ORIGIN);
  expect(blocked).toEqual([]);
});
