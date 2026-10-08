import type { BrowserContext, Page, Request, Route } from "@playwright/test";
import { test, expect } from "./_extension.js";

// Owner decisions 62 and 73 (option A): a plain "Restore purchase" link on the Chrome/Firefox
// settings page, in V3 new-sync builds only. Three lanes, as in sync-invitation.spec.ts:
//   - configured store-style build (STILL_TEST_SYNC_CONFIGURED=true): the 2.x settings page, with
//     no Restore purchase link;
//   - unconfigured V3 build (the other CI lane): no sign-in server, so no Restore purchase link;
//   - V3 build with sign-in (placeholder Supabase values plus VITE_MODERN_SETTINGS_SYNC_ENABLED=true,
//     built into a temporary directory): the full flow against a stubbed backend. Run it with
//       STILL_CHROMIUM_EXTENSION=/tmp/modern-configured STILL_EXPECT_MODERN_SIGN_IN=1
//     It is skipped everywhere else because CI builds only the first two.
//
// The stub answers only what the existing sign-in and entitlement paths ask: the email code, the
// session, the reconcile function and the entitlements row. Every other request is refused, and
// each test proves that no checkout function was ever called.

const LEGACY = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
const MODERN_SIGN_IN = process.env.STILL_EXPECT_MODERN_SIGN_IN === "1";
const RESTORED = "Still Pro is restored on this device.";
const NOTHING = "No Still Pro purchase was found for this account.";
const FAILED = "We couldn't finish checking. Nothing changed.";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const SESSION_ID = "00000000-0000-4000-8000-0000000000b2";
const EMAIL = "restore-check@still.test";

async function openSettings(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator("body")).toContainText("Still is");
  return page;
}

test.describe("configured store-style build", () => {
  test.skip(!LEGACY, "Legacy lane only");
  test("the 2.x settings page has no Restore purchase", async ({ context, extensionId }) => {
    await context.route(/^https?:/, (route) => route.abort());
    const page = await openSettings(context, extensionId);
    await page.waitForTimeout(500);
    await expect(page.getByRole("button", { name: "Restore purchase" })).toHaveCount(0);
    await expect(page.getByText(/Restore/)).toHaveCount(0);
  });
});

test.describe("V3 build without sign-in", () => {
  test.skip(LEGACY || MODERN_SIGN_IN, "Needs the unconfigured V3 build");
  test.use({ settingsProfile: "modern" });
  test("has no Restore purchase, because there is no account to check", async ({ context, extensionId }) => {
    await context.route(/^https?:/, (route) => route.abort());
    const page = await openSettings(context, extensionId);
    await expect(page.getByRole("button", { name: "YouTube Blocker" })).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByRole("button", { name: "Restore purchase" })).toHaveCount(0);
  });
});

/** An unsigned, test-only access token: built at runtime so no token-shaped literal is committed. */
function fakeAccessToken(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ sub: USER_ID, session_id: SESSION_ID, email: EMAIL, aud: "authenticated", role: "authenticated", iat: now, exp: now + 3600 }),
    "test-signature",
  ].join(".");
}

interface Backend {
  readonly requests: string[];
  entitled: boolean | "down";
}

async function stubBackend(context: BrowserContext, entitled: Backend["entitled"]): Promise<Backend> {
  const backend: Backend = { requests: [], entitled };
  const user = { id: USER_ID, aud: "authenticated", role: "authenticated", email: EMAIL, app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await context.route(/^https?:/, async (route: Route, request: Request) => {
    const url = new URL(request.url());
    if (url.hostname !== "still-audit.invalid") return route.abort();
    backend.requests.push(`${request.method()} ${url.pathname}`);
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    const path = url.pathname;
    if (path === "/auth/v1/otp") return json(route, 200, {});
    if (path === "/auth/v1/verify") {
      const now = Math.floor(Date.now() / 1000);
      return json(route, 200, { access_token: fakeAccessToken(), token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: "test-refresh", user });
    }
    if (path === "/auth/v1/user") return json(route, 200, user);
    if (path === "/functions/v1/reconcile-entitlement")
      return backend.entitled === "down" ? json(route, 503, { error: "unavailable" }) : json(route, 200, {});
    if (path === "/rest/v1/entitlements") {
      if (backend.entitled === "down") return json(route, 503, { message: "unavailable" });
      const row = backend.entitled ? { still_sync: true } : null;
      const single = (request.headers()["accept"] ?? "").includes("vnd.pgrst.object");
      return single
        ? row ? json(route, 200, row) : json(route, 406, { code: "PGRST116", message: "no rows" })
        : json(route, 200, row ? [row] : []);
    }
    // Settings sync, analytics and anything else: unavailable. Sync shows its own failed line.
    return json(route, 503, { error: "unavailable in this test" });
  });
  return backend;
}

async function signIn(page: Page): Promise<void> {
  const consent = page.getByRole("dialog", { name: "Your email is only for sign-in" });
  await expect(consent).toBeVisible();
  await consent.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Email address").fill(EMAIL);
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("6-digit code").fill("123456");
  await page.getByRole("button", { name: "Verify code" }).click();
}

/** Calls to the existing reconcile function (preflights excluded). */
function reconciles(backend: Backend): number {
  return backend.requests.filter((r) => r === "POST /functions/v1/reconcile-entitlement").length;
}

function expectNoCheckout(backend: Backend): void {
  expect(backend.requests.filter((r) => /create-web-checkout|checkout/i.test(r))).toEqual([]);
}

async function expectNothingOffered(page: Page): Promise<void> {
  await expect(page.getByText(/Get Still Pro|Buy|\$\d|Opening checkout/)).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Still Pro" })).toHaveCount(0);
}

test.describe("V3 build with sign-in: Restore purchase", () => {
  test.skip(!MODERN_SIGN_IN, "Needs the modern sign-in build (see header)");
  test.use({ settingsProfile: "modern" });

  test("signed out: the normal sign-in first, then one check; a past buyer is restored and nothing unlocks", async ({ context, extensionId }) => {
    const backend = await stubBackend(context, true);
    const page = await openSettings(context, extensionId);
    const link = page.getByRole("button", { name: "Restore purchase" });
    await expect(link).toBeVisible();
    await link.click();
    expect(reconciles(backend)).toBe(0);
    await signIn(page);
    await expect(page.getByText(RESTORED)).toBeVisible();
    await expect(page.getByText(EMAIL)).toBeVisible();
    // Sign-in's own existing reconcile, then exactly one for the check.
    await page.waitForTimeout(300);
    expect(reconciles(backend)).toBe(2);
    expectNoCheckout(backend);
    await expectNothingOffered(page);
    // Nothing extra unlocks while the paid flags are off: the Still Pro rows stay locked and inert.
    await page.getByRole("button", { name: "YouTube Blocker" }).click();
    const lock = page.getByRole("button", { name: /\. Included in Still Pro\.$/ }).first();
    await expect(lock).toBeVisible();
    await expect(lock).toHaveAttribute("aria-disabled", "true");
    await lock.dispatchEvent("click");
    await expectNothingOffered(page);
    // The entitlement is recorded locally for this account, dormant until Pro returns.
    const worker = context.serviceWorkers()[0]!;
    const record = await worker.evaluate(async () => {
      const all = await (globalThis as unknown as { chrome: { storage: { local: { get(k: null): Promise<Record<string, unknown>> } } } }).chrome.storage.local.get(null);
      return Object.entries(all).find(([key]) => /entitle/i.test(key))?.[1] ?? null;
    });
    expect(record).toMatchObject({ entitled: true, userId: USER_ID });
  });

  test("signed in, no purchase: the existing nothing-found wording", async ({ context, extensionId }) => {
    const backend = await stubBackend(context, false);
    const page = await openSettings(context, extensionId);
    await page.getByRole("button", { name: /^Sign in/ }).first().click();
    await signIn(page);
    await expect(page.getByText(EMAIL)).toBeVisible();
    // Signing in runs its own existing reconcile; let it land before counting the check's.
    await expect.poll(() => reconciles(backend)).toBe(1);
    await page.getByRole("button", { name: "Restore purchase" }).click();
    await expect(page.getByText(NOTHING)).toBeVisible();
    expect(reconciles(backend)).toBe(2);
    await page.waitForTimeout(300);
    expect(reconciles(backend)).toBe(2);
    expectNoCheckout(backend);
    await expectNothingOffered(page);
  });

  test("server unavailable: the existing failed wording with Try again", async ({ context, extensionId }) => {
    const backend = await stubBackend(context, false);
    const page = await openSettings(context, extensionId);
    await page.getByRole("button", { name: /^Sign in/ }).first().click();
    await signIn(page);
    await expect(page.getByText(EMAIL)).toBeVisible();
    backend.entitled = "down";
    await page.getByRole("button", { name: "Restore purchase" }).click();
    await expect(page.getByText(FAILED)).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore purchase" })).toBeDisabled();
    backend.entitled = true;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText(RESTORED)).toBeVisible();
    expectNoCheckout(backend);
    await expectNothingOffered(page);
  });
});
