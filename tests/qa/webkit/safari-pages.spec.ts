import { expect, test, type Browser, type Page } from "@playwright/test";
import { buildProblems, launchWebKit, openLane, type Lane, type StateName } from "./harness.js";
import { qaState } from "./shim/states.js";

// T2 checks on the BUILT Safari extension pages (popup and settings) in WebKit, with recorded
// native states behind them. Cell ids follow the QA plan: SI = Safari on iPhone/iPad, SM = Safari on
// the Mac. What they cannot prove: Safari's own popup sheet or popover, the extension runtime, or
// content-script blocking (owner device and simulator lanes).

let browser: Browser;
const lanes: Lane[] = [];
test.beforeAll(async () => {
  browser = await launchWebKit();
});
test.afterEach(async () => {
  await Promise.all(lanes.splice(0).map((lane) => lane.close()));
});
test.afterAll(async () => {
  await browser?.close();
});
test.skip(buildProblems().length > 0, `needs the V3 opt-in builds: ${buildProblems().join("; ")}`);

async function open(state: StateName | Parameters<typeof openLane>[1]["state"], page: "popup" | "options", viewport = { width: 375, height: 667 }): Promise<{ lane: Lane; page: Page }> {
  const lane = await openLane(browser, { state, viewport });
  lanes.push(lane);
  const p = await lane.open(lane.safariUrl(page));
  return { lane, page: p };
}

const WRITES = new Set(["settingsIntent", "settingsAtomic", "set", "still:settings-intent", "still:settings-record", "setEntitlementRecord"]);
const writes = (lane: Lane) => lane.model.log.filter((m) => WRITES.has(String((m.message as { kind?: unknown }).kind)));

test("J4.SI the popup renders the app's saved choices and opening it writes nothing", async () => {
  const { lane, page } = await open("ios-fresh", "popup");
  await expect(page.getByRole("heading", { name: "Still is active" })).toBeVisible();
  for (const service of ["YouTube", "Instagram", "Facebook"])
    await expect(page.getByRole("switch", { name: `Still on ${service}` })).toBeChecked();
  await expect(page.getByRole("switch", { name: "TikTok website" })).toBeChecked();
  // iOS gets the mobile popup: its Settings button carries the mobile accessible name.
  await expect(page.getByRole("button", { name: "Settings. Opens Still settings." })).toBeVisible();
  await page.waitForTimeout(500);
  expect(writes(lane)).toEqual([]);
});

test("J10.SI a saved Still Off shows as off with every choice kept, and is never rewritten", async () => {
  const { lane, page } = await open("ios-still-off", "popup");
  await expect(page.getByRole("heading", { name: "Still is off" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Still", exact: true })).not.toBeChecked();
  for (const service of ["YouTube", "Instagram", "Facebook"])
    await expect(page.getByRole("switch", { name: `Still on ${service}` })).toBeChecked();
  await page.waitForTimeout(500);
  expect(writes(lane)).toEqual([]);
  expect(lane.model.currentRecord()?.settings.globalOn).toBe(false);
});

test("J4.SM macOS gets the desktop popup with the approved Settings label", async () => {
  const { page } = await open("mac-fresh", "popup", { width: 380, height: 600 });
  await expect(page.getByRole("heading", { name: "Still is active" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Still settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings. Opens Still settings." })).toHaveCount(0);
});

test("J4.SI one switch commits exactly one settings intent to the App Group, never a snapshot", async () => {
  const { lane, page } = await open("ios-fresh", "popup");
  const tiktok = page.getByRole("switch", { name: "TikTok website" });
  await expect(tiktok).toBeChecked();
  await tiktok.click();
  await expect(tiktok).not.toBeChecked();
  await expect.poll(() => writes(lane).length).toBe(1);
  await page.waitForTimeout(500);
  const [intent] = writes(lane);
  expect(intent?.surface).toBe("extension-native");
  expect(intent?.message).toMatchObject({ kind: "settingsIntent", path: "services.tiktok", value: false });
  expect(writes(lane)).toHaveLength(1);
  expect(lane.model.currentRecord()?.settings.services.tiktok).toBe(false);
  // The page mirrored the committed record into browser.storage for the content scripts.
  const mirrored = await page.evaluate(async () => {
    const area = (globalThis as unknown as { chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } } }).chrome.storage.local;
    return (await area.get("still:settings"))["still:settings"] as { settings: { services: { tiktok: boolean } } };
  });
  expect(mirrored.settings.services.tiktok).toBe(false);
});

test("J12.SI paid tier off: no price, purchase, sign-in or account action on the popup or settings page", async () => {
  for (const surface of ["popup", "options"] as const) {
    const { lane, page } = await open("ios-fresh", surface, { width: 420, height: 900 });
    await expect(page.getByRole("heading", { name: "Still is active" })).toBeVisible();
    // Open every service so collapsed rows are inspected too.
    for (const service of ["YouTube", "Instagram", "Facebook"]) await page.getByRole("button", { name: `${service} Blocker`, exact: true }).click();
    const text = await page.locator("body").innerText();
    expect(text, surface).not.toMatch(/\$|€|£|\bBuy\b|Purchase|Get Still Pro|Restore/);
    for (const name of [/^Sign in$/, /^Sign out$/, /^Delete account$/, /^Try again$/])
      await expect(page.getByRole("button", { name }), `${surface} ${name}`).toHaveCount(0);
    expect(lane.model.messages().map((m) => (m as { kind?: string }).kind), surface).not.toContain("purchase");
  }
});

test("J9.SI the app unreachable with a retained copy: last choices shown, switches held, Try again only reads", async () => {
  const { lane, page } = await open(qaState({ name: "ios-native-absent", native: "absent" }), "popup");
  await expect(page.getByText("Settings are unavailable.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Still is active" })).toBeVisible();
  const before = lane.model.log.length;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => lane.model.log.length).toBeGreaterThan(before);
  await page.getByRole("switch", { name: "TikTok website" }).click({ force: true });
  await page.waitForTimeout(500);
  expect(writes(lane)).toEqual([]);
});

test("J7.SI a 2.1.x record the app never converted keeps the legacy popup (no V3 screen, no write)", async () => {
  const { lane, page } = await open(qaState({ name: "ios-legacy", appGroup: "legacy" }), "popup");
  // The legacy popup's own heading, not the V3 hero.
  await expect(page.getByText("Still is on", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Still is active" })).toHaveCount(0);
  expect(await page.locator('link[href*="v3-mount"]').count()).toBe(0);
  await expect(page.getByRole("button", { name: "Settings. Opens Still settings." })).toHaveCount(0);
  expect(writes(lane)).toEqual([]);
});

test("J4.SI the settings page renders with Help and without any account action", async () => {
  const { lane, page } = await open("mac-fresh", "options", { width: 560, height: 1000 });
  await expect(page.getByRole("heading", { name: "Still is active" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Settings sync" })).toBeVisible();
  for (const name of ["Setup guide", "Contact support", "Privacy policy"]) await expect(page.getByRole("button", { name })).toBeVisible();
  await page.waitForTimeout(500);
  expect(writes(lane)).toEqual([]);
});

test("the shim acts only on the two origins under test", async () => {
  const lane = await openLane(browser, { state: "ios-fresh" });
  lanes.push(lane);
  const page = await lane.context.newPage();
  await page.route("http://unrelated.invalid/**", (route) => route.fulfill({ contentType: "text/html", body: "<p>x</p>" }));
  await page.goto("http://unrelated.invalid/");
  expect(await page.evaluate(() => [typeof (globalThis as { chrome?: unknown }).chrome, typeof (globalThis as { webkit?: unknown }).webkit])).toEqual(["undefined", "undefined"]);
});
