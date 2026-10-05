import { expect, test, type Browser, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APPLE_WEBVIEW, buildProblems, launchWebKit, openLane, type AppEntry, type Lane, type StateName } from "./harness.js";

// T2 checks on the BUILT Apple web view (app-webview, the D12 onboarding and D04 settings screens
// in the opted-in build) in WebKit, with recorded native replies behind window.webkit.
//
// Finding (README "Findings"): the shipped single-file page (dist/index.html) renders nothing.
// Its inlined module still carries Vite's unreplaced preload placeholder `__VITE_PRELOAD__`, and
// the dynamic imports of the D12 and D04 screens throw a ReferenceError that main.ts swallows. The
// first test pins that as an expected failure, so it flags itself the moment the build is fixed.
// The DIAGNOSTIC tests below use the chunk Vite emitted beside the page, which is byte-identical
// apart from that placeholder (pinned by the second test), to check the screens behind the bug.

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

async function open(state: StateName, entry: AppEntry, viewport = { width: 393, height: 759 }): Promise<{ lane: Lane; page: Page }> {
  const lane = await openLane(browser, { state, viewport });
  lanes.push(lane);
  return { lane, page: await lane.open(lane.appUrl(entry)) };
}
const kinds = (lane: Lane) => lane.model.messages("app").map((m) => (m as { kind?: string }).kind);

test("J1.SI the shipped Apple web view shows the D12 onboarding on first launch", async () => {
  // The known cause first, as ordinary assertions: any other reason for a blank page is a red test.
  const shipped = readFileSync(join(APPLE_WEBVIEW, "index.html"), "utf8");
  expect(shipped).toContain("__VITE_PRELOAD__");
  const { page } = await open("app-iphone-onboarding", "shipped");
  // The page's own global scope cannot resolve the placeholder: loading a screen raises this.
  const raised = await page.evaluate(() => {
    try {
      // The exact identifier the inlined module references, looked up in the page's global scope.
      (0, eval)("__VITE_PRELOAD__");
      return null;
    } catch (error) {
      return error instanceof Error ? error.name : String(error);
    }
  });
  expect(raised).toBe("ReferenceError");
  // Only now the expected failure (VD-9): when the build is fixed this passes and flags itself.
  test.fail(true, "VD-9: dist/index.html references the unreplaced __VITE_PRELOAD__ and renders nothing");
  await expect(page.getByRole("heading", { name: "Welcome to Still" })).toBeVisible({ timeout: 8_000 });
});

test("the diagnostic entry is the shipped module with only the preload placeholder resolved", () => {
  const shipped = readFileSync(join(APPLE_WEBVIEW, "index.html"), "utf8");
  const inline = /<script type="module">\n?([\s\S]*?)<\/script>/.exec(shipped)?.[1] ?? "";
  const style = /<style>\n?([\s\S]*?)<\/style>/.exec(shipped)?.[1] ?? "";
  const assets = join(APPLE_WEBVIEW, "assets");
  const emitted = readFileSync(join(assets, readdirSync(assets).find((f) => f.endsWith(".js"))!), "utf8");
  const css = readFileSync(join(assets, readdirSync(assets).find((f) => f.endsWith(".css"))!), "utf8");
  expect(inline.length).toBeGreaterThan(100_000);
  expect(inline.replaceAll("__VITE_PRELOAD__", "void 0").trim()).toBe(emitted.trim());
  expect(style.trim()).toBe(css.trim());
});

test("DIAGNOSTIC J1.SI onboarding: three steps from the native gate, completed once, then settings", async () => {
  const { lane, page } = await open("app-iphone-onboarding", "emitted-chunk");
  await expect(page.getByRole("heading", { name: "Welcome to Still" })).toBeVisible();
  await expect(page.getByText("Step 1 of 3")).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Turn on Still in Safari" })).toBeVisible();
  await page.getByRole("button", { name: "I've turned it on", exact: true }).click();
  await expect(page.getByRole("heading", { name: "You're set" })).toBeVisible();
  // iOS has no public way to open Safari itself: that button stays disabled there.
  await expect(page.getByRole("button", { name: "Open Safari" })).toBeDisabled();
  await page.getByRole("button", { name: "Go to Settings" }).click();
  await expect(page.getByRole("heading", { name: "Still is active" })).toBeVisible();
  expect(kinds(lane).filter((k) => k === "completeOnboarding")).toHaveLength(1);
  // Atomic mode: one native initialize with unknown ownership, and no settings intent on open.
  const atomic = lane.model.messages("app").filter((m) => (m as { kind?: string }).kind === "settingsAtomic");
  expect(atomic.length).toBeGreaterThanOrEqual(1);
  for (const m of atomic) expect(JSON.parse((m as { command: string }).command)).toEqual({ action: "initialize", ownership: "unknown" });
  expect(kinds(lane)).not.toContain("settingsIntent");
});

test("DIAGNOSTIC J12.SI paid tier off: settings show no price or purchase and never ask native for one", async () => {
  const { lane, page } = await open("app-iphone", "emitted-chunk");
  await expect(page.getByRole("heading", { name: "Still is active" })).toBeVisible();
  for (const service of ["YouTube", "Instagram", "Facebook"]) await page.getByRole("button", { name: `${service} Blocker`, exact: true }).click();
  expect(await page.locator("body").innerText()).not.toMatch(/\$|€|£|\bBuy\b|Get Still Pro|One payment/);
  for (const kind of ["purchase", "price", "configurePurchases", "attachPurchases"]) expect(kinds(lane)).not.toContain(kind);
});

for (const [state, text] of [
  ["app-iphone-restore-none", "No Still Pro purchase was found for this Apple Account."],
  ["app-ipad-restore-failed", /couldn.t finish/i],
] as const) {
  test(`DIAGNOSTIC J12.SI free-period Restore asks native exactly once and shows its answer (${state})`, async () => {
    const { lane, page } = await open(state, "emitted-chunk");
    await page.getByRole("button", { name: "Restore purchase", exact: true }).click();
    await expect(page.getByText(text).first()).toBeVisible();
    expect(kinds(lane).filter((k) => k === "restore")).toHaveLength(1);
  });
}

test("DIAGNOSTIC J4.SI a settings switch commits one native settings intent", async () => {
  const { lane, page } = await open("app-iphone", "emitted-chunk");
  const tiktok = page.getByRole("switch", { name: "TikTok website" });
  await expect(tiktok).toBeChecked();
  await tiktok.click();
  await expect(tiktok).not.toBeChecked();
  await expect.poll(() => kinds(lane).filter((k) => k === "settingsIntent").length).toBe(1);
  expect(lane.model.currentRecord()?.settings.services.tiktok).toBe(false);
});

test("DIAGNOSTIC D12 onboarding fills the web view (Continue sits at the bottom, as designed)", async () => {
  const { page } = await open("app-iphone-onboarding", "emitted-chunk");
  // The step rendered (heading visible, .ob present), so a short .ob below is the layout cause.
  await expect(page.getByRole("heading", { name: "Welcome to Still" })).toBeVisible();
  await expect(page.locator("main.ob")).toHaveCount(1);
  test.fail(true, "VD-10: .ob { min-height: 100% } resolves against #app/body, whose heights are auto");
  const [height, viewport] = await page.evaluate(() => [document.querySelector(".ob")!.getBoundingClientRect().height, innerHeight]);
  expect(height).toBeGreaterThanOrEqual(viewport - 1);
});

test("the shim refuses what WebBridgeRouter refuses and answers in its JSON-string form", async () => {
  const { page } = await open("app-iphone", "emitted-chunk");
  await expect(page.getByRole("heading", { name: "Still is active" })).toBeVisible();
  const post = (message: unknown) =>
    page.evaluate(async (m) => {
      try {
        const port = (globalThis as unknown as { webkit: { messageHandlers: { still: { postMessage(x: unknown): Promise<unknown> } } } }).webkit.messageHandlers.still;
        return { reply: await port.postMessage(m) };
      } catch (error) {
        return { rejected: error instanceof Error ? error.message : String(error) };
      }
    }, message);
  const refusedSettings = "still: unrecognized settings message";
  for (const malformed of [
    { kind: "settingsIntent", path: "services.tiktok", value: false },
    { kind: "settingsIntent", path: "services.tiktok", value: "false", updatedAt: 1 },
    { kind: "settingsIntent", path: "services.nope", value: false, updatedAt: 1 },
    { kind: "settingsIntent", path: "services.tiktok", value: false, updatedAt: 1, extra: true },
    { kind: "settingsAtomic", command: { action: "initialize" } },
    { kind: "settingsAtomic", command: "{}", extra: 1 },
  ])
    expect((await post(malformed)).rejected, JSON.stringify(malformed)).toContain(refusedSettings);
  expect((await post({ kind: "openDestination", destination: "settingsAppStillPage", url: "https://x.invalid" })).rejected).toContain("open refused (malformed)");
  expect((await post({ kind: "openDestination", destination: "safari" })).rejected).toContain("open refused (unsupported)");
  expect(await post({ kind: "openDestination", destination: "settingsAppStillPage" })).toEqual({ reply: JSON.stringify({ ok: true, destination: "settingsAppStillPage" }) });
  const entitlement = await post({ kind: "getEntitlement" });
  expect(typeof entitlement.reply).toBe("string");
  expect(Object.keys(JSON.parse(entitlement.reply as string)).sort()).toEqual(["entitled", "installId", "source", "updatedAt"]);
  for (const kind of ["onboardingState", "safariSetupState", "receiptStatus", "analyticsContext", "acknowledgeAnalyticsNotice"])
    expect(typeof (await post({ kind })).reply, kind).toBe("string");
});
