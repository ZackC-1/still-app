import { expect, test, type Page } from "@playwright/test";
import { APPROVED } from "../src/copy.js";
import { FakeAdminFunction, OWNER_TOKEN, STRANGER_TOKEN } from "../src/test-support/fake-admin.js";
import { ORIGIN } from "./playwright.config.js";

const A = APPROVED.allowances;

/** Mock the same-origin Supabase endpoints: email code, verify, and the admin function. */
async function mockSupabase(page: Page, server: FakeAdminFunction, sessionToken: string) {
  await page.route(`${ORIGIN}/auth/v1/otp*`, (route) => route.fulfill({ status: 200, json: {} }));
  await page.route(`${ORIGIN}/auth/v1/verify*`, (route) =>
    route.fulfill({
      status: 200,
      json: {
        access_token: sessionToken,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: "refresh-token",
        user: { id: "00000000-0000-4000-8000-0000000000aa", aud: "authenticated", role: "authenticated", email: "person@example.com", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
      },
    }),
  );
  await page.route(`${ORIGIN}/functions/v1/product-policy-admin`, async (route) => {
    const request = route.request();
    const bearer = /^Bearer (.+)$/.exec(request.headers()["authorization"] ?? "")?.[1] ?? null;
    const reply = await server.transport(() => bearer)(request.postDataJSON());
    await route.fulfill({ status: reply.status || 500, json: reply.body });
  });
}

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel(APPROVED.signIn.emailLabel).fill("person@example.com");
  await page.getByRole("button", { name: APPROVED.signIn.send }).click();
  await page.getByLabel(APPROVED.signIn.codeLabel).fill("123456");
  await page.getByRole("button", { name: APPROVED.signIn.verify }).click();
}

function watch(page: Page) {
  const violations: string[] = [];
  const offOrigin: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  page.on("pageerror", (error) => violations.push(String(error)));
  page.on("request", (request) => {
    if (!request.url().startsWith(ORIGIN) && !request.url().startsWith("data:")) offOrigin.push(request.url());
  });
  return { violations, offOrigin };
}

test("owner: sign in, change allowances, success only after readback, under the strict CSP", async ({ page }) => {
  const server = new FakeAdminFunction();
  server.seed("rating", "sandbox", {
    master: false,
    surfaces: Object.fromEntries(["chrome_desktop", "edge_desktop", "firefox_desktop", "firefox_android", "apple_mobile_host", "apple_macos_host"].map((s) => [s, false])),
    builds: [{ surface: "chrome_desktop", build: "chrome-3.0.0" }],
  });
  const seen = watch(page);
  await mockSupabase(page, server, OWNER_TOKEN);
  await signIn(page);

  const region = page.getByRole("region", { name: A.title });
  await expect(region.getByRole("heading", { name: A.title })).toBeVisible();
  await expect(region.getByText(A.body)).toBeVisible();
  await expect(region.getByText(A.deferred)).toBeVisible();
  await region.getByRole("switch", { name: A.all }).click();
  await region.getByRole("switch", { name: "Chrome desktop" }).click();
  await expect(region).toContainText(`${A.previewLead}Chrome desktop.`);

  const before = server.calls.length;
  await region.getByRole("button", { name: A.apply }).click();
  await expect(region.getByText(A.applied)).toBeVisible();
  expect(server.calls.slice(before).map((c) => c.action)).toEqual(["preview", "apply", "read"]);
  expect(server.current("rating", "sandbox")!.revision).toBe(2);

  expect(seen.violations).toEqual([]);
  expect(seen.offOrigin).toEqual([]);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
});

test("non-owner: a signed-in account without access sees only 'Not available here'", async ({ page }) => {
  const server = new FakeAdminFunction();
  const seen = watch(page);
  await mockSupabase(page, server, STRANGER_TOKEN);
  await signIn(page);
  await expect(page.getByText(APPROVED.unavailable)).toBeVisible();
  await expect(page.getByRole("region", { name: A.title })).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toMatch(/owner|allowlist|admin/i);
  expect(seen.violations).toEqual([]);
});
