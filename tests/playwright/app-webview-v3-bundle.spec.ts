import { expect, test, webkit, type Browser, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS } from "../../packages/shared-types/src/index.js";
import { SUPPORT_EMAIL } from "../../packages/core/src/ui/config.js";
import { helpHitAreas } from "./_help-hit-areas.js";
import { expectLockedRowsOnOneLine, measureOptionRows } from "./_locked-rows.js";
import { AtomicSettingsWriter } from "../../packages/core/src/storage/atomic-settings.js";
import type { StorageAdapter, StoredSettingsRecord } from "../../packages/core/src/storage/adapter.js";

// Guard for the Apple app's single-file web view in the V3 opt-in build (VITE_APPLE_ATOMIC_SETTINGS
// with no Supabase configuration: the D12 onboarding and D04 settings screens). That build is the
// only app-webview build with dynamic import()s, and Vite resolves their preload placeholder
// (__VITE_PRELOAD__) late in its own bundle step. A single-file inliner that copies the chunk too
// early ships the raw placeholder; WKWebView then throws a ReferenceError that main.ts swallows, and
// the app shows a blank screen. This spec builds that bundle into a temporary folder (never the
// package's dist), checks it carries no unresolved Vite placeholder, and opens it over file:// in
// WebKit, the engine behind WKWebView, with a minimal stand-in for the native message port.
//
// The bundle is built with explicit values (every inherited VITE_* removed, Supabase and analytics
// empty), so it is the same bundle in either CI lane; it runs in the unconfigured lane only.

test.skip(process.env.STILL_TEST_SYNC_CONFIGURED === "true", "lane-independent bundle; runs in the unconfigured lane");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let outDir = "";
let html = "";

test.beforeAll(() => {
  test.setTimeout(240_000);
  outDir = mkdtempSync(join(tmpdir(), "still-app-webview-v3-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITE_")));
  const build = spawnSync(
    "pnpm",
    ["--filter", "@still/app-webview", "exec", "vite", "build", "--outDir", outDir, "--emptyOutDir"],
    {
      cwd: ROOT,
      // Explicit empty values also win over any local packages/app-webview/.env.
      env: {
        ...env,
        VITE_APPLE_ATOMIC_SETTINGS: "true",
        VITE_SUPABASE_URL: "",
        VITE_SUPABASE_ANON_KEY: "",
        VITE_POSTHOG_KEY: "",
        VITE_POSTHOG_HOST: "",
        VITE_REVIEW_SIGNIN_EMAIL: "",
      },
      encoding: "utf8",
    },
  );
  if (build.status !== 0) throw new Error(`app-webview V3 build failed:\n${build.stdout}\n${build.stderr}`);
  html = readFileSync(join(outDir, "index.html"), "utf8");
});

test.afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

test("the V3 single-file bundle carries no unresolved Vite placeholder and inlines the final chunk", () => {
  // It really is the opted-in build: the D12/D04 screens load through the dynamic imports.
  expect(html).toContain("showAppleOnboardingFirst");
  expect(html.match(/__VITE_[A-Z0-9_]+__/g) ?? []).toEqual([]);
  expect(html).not.toMatch(/__vite__mapDeps|__VITE_PRELOAD__/);
  // Single file: nothing left for file:// to fetch.
  expect(html).not.toMatch(/<script\b[^>]*\bsrc=/);
  expect(html).not.toMatch(/<link\b[^>]*\brel="stylesheet"/);
  // The inlined module is byte-for-byte the chunk Vite emitted after its own final rewrites.
  const scripts = [...html.matchAll(/<script type="module">\n([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  const assets = join(outDir, "assets");
  const chunk = readdirSync(assets).filter((name) => name.endsWith(".js"));
  expect(chunk).toHaveLength(1);
  expect(scripts[0]![1]).toBe(readFileSync(join(assets, chunk[0]!), "utf8"));
});

// ---- WebKit render check -------------------------------------------------------------------------

/** An in-memory App Group holding an untouched 2.x record, initialized by the reviewed writer. */
class MemoryAppGroup implements StorageAdapter {
  record: StoredSettingsRecord | null = { settings: DEFAULT_SETTINGS, syncMetadata: null, syncEpoch: 0 };
  async get(): Promise<StoredSettingsRecord | null> {
    return this.record ? structuredClone(this.record) : null;
  }
  async set(record: StoredSettingsRecord): Promise<void> {
    const { intentCommitted: _transient, ...persisted } = record;
    this.record = structuredClone(persisted);
  }
  subscribe(): () => void {
    return () => {};
  }
}

/** Answers window.webkit.messageHandlers.still the way WebBridgeRouter.swift shapes its replies. */
function nativeHost(
  showOnboarding: boolean,
  platform: "ios" | "macos" = "ios",
  settingsUnavailable = false,
): (message: unknown) => Promise<unknown> {
  const group = new MemoryAppGroup();
  let n = 0;
  const writer = new AtomicSettingsWriter(group, () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`);
  let onboardingComplete = false;
  return async (message) => {
    const m = (message ?? {}) as Record<string, unknown>;
    switch (m.kind) {
      case "get":
        return group.record ? JSON.stringify(group.record) : "";
      case "settingsAtomic": {
        const command = JSON.parse(String(m.command)) as { action?: string; ownership?: "unknown" };
        if (command.action !== "initialize" || settingsUnavailable) return JSON.stringify({ status: "unavailable" });
        return JSON.stringify(await writer.initialize(command.ownership ?? "unknown"));
      }
      case "onboardingState":
        return { ok: true, shouldShow: showOnboarding && !onboardingComplete, platform, osMajorVersion: 26 };
      case "completeOnboarding":
        onboardingComplete = true;
        return { ok: true };
      case "safariSetupState":
        return platform === "ios"
          ? { ok: true, platform, extensionStatus: "unknown", enableLocation: "settingsAppStillPage" }
          : { ok: true, platform, extensionStatus: "unknown", enableLocation: "safariExtensionSettings" };
      case "receiptStatus":
        return { receipt: "noSignal" };
      case "setAccountSyncStatus":
        return { ok: true };
      default:
        // analyticsContext and anything else: the reply a native host gives a message it refuses.
        throw new Error(`still: unrecognized message ${String(m.kind)}`);
    }
  };
}

let browser: Browser;
test.describe("the V3 bundle in WebKit over file://", () => {
  test.beforeAll(async () => {
    browser = await webkit.launch();
  });
  test.afterAll(async () => {
    await browser?.close();
  });

  async function open(
    showOnboarding: boolean,
    platform: "ios" | "macos" = "ios",
    settingsUnavailable = false,
    width?: number,
  ): Promise<{ page: Page; errors: string[] }> {
    const viewport = platform === "ios" ? { width: width ?? 393, height: 759 } : { width: width ?? 480, height: 900 };
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.exposeFunction("__stillGuardNative", nativeHost(showOnboarding, platform, settingsUnavailable));
    await page.addInitScript(() => {
      const w = window as unknown as {
        webkit?: unknown;
        __stillGuardNative: (message: unknown) => Promise<unknown>;
      };
      w.webkit = {
        messageHandlers: {
          still: { postMessage: (message: unknown) => w.__stillGuardNative(JSON.parse(JSON.stringify(message))) },
        },
      };
    });
    await page.goto(pathToFileURL(join(outDir, "index.html")).href);
    return { page, errors };
  }

  test("D12 onboarding renders when the native gate asks for it", async () => {
    const { page, errors } = await open(true);
    await expect(page.getByRole("heading", { name: "Welcome to Still" })).toBeVisible();
    await expect(page.getByText("Step 1 of 3")).toBeVisible();
    expect((await page.locator("#app").innerText()).trim()).not.toBe("");
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test("D04 settings render once onboarding is complete", async () => {
    const { page, errors } = await open(false);
    await expect(page.getByRole("heading", { name: "Still is active" })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Still", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    await page.context().close();
  });

  // A6 (owner, 22 Oct): the Mac app's settings take the canvas width, 24px side padding and 432px
  // cards in its 480px window; the iPhone keeps its 16px side padding (cards 361px at 393 wide).
  for (const [platform, x, width] of [["macos", 24, 432], ["ios", 16, 361]] as const) {
    // Review F3: the host's own containers (here the "Try again" recovery) take the same width.
    test(`D04 settings on ${platform}: the recovery's button is ${width}px wide at x ${x}`, async () => {
      const { page, errors } = await open(false, platform, true);
      const retry = page.getByRole("button", { name: "Try again" });
      await expect(retry).toBeVisible();
      // The width rule follows the platform once the first setup read reports it.
      await expect
        .poll(async () => {
          const box = (await retry.boundingBox())!;
          return `${Math.round(box.x)} ${Math.round(box.width)}`;
        })
        .toBe(`${x} ${width}`);
      expect(errors).toEqual([]);
      await page.context().close();
    });

    test(`D04 settings on ${platform}: cards are ${width}px wide at x ${x}`, async () => {
      const { page, errors } = await open(false, platform);
      await expect(page.getByRole("heading", { name: "Still is active" })).toBeVisible();
      const cards = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".app > *")]
          .filter((el) => el.offsetParent && el.getBoundingClientRect().height > 0)
          .map((el) => {
            const box = el.getBoundingClientRect();
            return `${el.className.split(" ")[0] || el.tagName}: ${Math.round(box.x)} ${Math.round(box.width)}`;
          }),
      );
      expect(cards.length).toBeGreaterThan(2);
      for (const card of cards) expect(card).toMatch(new RegExp(`: ${x} ${width}$`));
      expect(errors).toEqual([]);
      await page.context().close();
    });
  }

  // ISS-0122 (owner, 22 Oct): a locked Still Pro row is its name and the Still Pro chip, no switch,
  // on one line and as tall as a free row (46px), on the iPhone at 375pt and 393pt and on the Mac
  // (480px window). This bundle has the paid tier off, so its Still Pro rows are the dormant locked
  // rows. At 375pt "Explore recommendations" (184px) is wider than the 155px the canvas chip leaves
  // it, so that one name wraps beside the chip (it already carries a second line, "Search stays.").
  for (const [platform, width, nameWraps] of [
    ["ios", 375, ["Explore recommendations"]],
    ["ios", 393, []],
    ["macos", 480, []],
  ] as const)
    test(`D04 settings on ${platform} at ${width}px: locked rows are one 46px line with no switch`, async () => {
      const { page, errors } = await open(false, platform, false, width);
      await expect(page.getByRole("heading", { name: "Still is active" })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expectLockedRowsOnOneLine(await measureOptionRows(page), 46, `${platform} ${width}px`, nameWraps);
      expect(errors).toEqual([]);
      await page.context().close();
    });

  // Full-width buttons are 54px tall in the Apple apps and 44px in Chrome and Firefox (owner ruling;
  // the browser side is block-button-heights.spec.ts). In the apps the height comes from the default
  // block-button padding; see the "Full-width button heights" note in components.css.
  for (const platform of ["ios", "macos"] as const) {
    test(`D04 settings on ${platform}: full-width buttons are 54px tall`, async () => {
      const { page, errors } = await open(false, platform);
      await expect(page.getByRole("heading", { name: "Still is active" })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const heights = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".primary.block, .secondary.block")]
          .filter((el) => el.offsetParent)
          .map((el) => `${el.textContent!.trim()}: ${Math.round(el.getBoundingClientRect().height)}`),
      );
      expect(heights.length, "a full-width button on the signed-out settings screen").toBeGreaterThan(0);
      for (const entry of heights) expect(entry).toMatch(/: 54$/);
      expect(errors).toEqual([]);
      await page.context().close();
    });

    // Review F2 (22 Oct): an outlined (bordered) block button is 54px too, whatever its border. The
    // real "Try again" recovery; then the host's other outlined buttons ("Verify purchase", "Link
    // Still Pro to your account", the purchase screen's "Back to Settings"), drawn in the same
    // containers the host draws them in, with the bundle's own stylesheet.
    test(`D04 settings on ${platform}: outlined full-width buttons are 54px tall`, async () => {
      const { page, errors } = await open(false, platform, true);
      const retry = page.getByRole("button", { name: "Try again" });
      await expect(retry).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(Math.round((await retry.boundingBox())!.height), "Try again").toBe(54);
      const drawn = await page.evaluate(() => {
        const host = document.createElement("div");
        host.innerHTML = [
          '<div class="still-ui app" data-host="apple"><button type="button" class="secondary block">Verify purchase</button></div>',
          '<div class="still-ui app" data-host="apple"><button type="button" class="secondary block">Link Still Pro to your account</button></div>',
          '<main class="still-ui ob" data-host="apple"><button type="button" class="secondary block">Back to Settings</button><button type="button" class="primary block">Get Still Pro</button></main>',
        ].join("");
        document.body.append(host);
        return [...host.querySelectorAll("button")].map(
          (el) => `${el.textContent}: ${Math.round(el.getBoundingClientRect().height)}`,
        );
      });
      for (const entry of drawn) expect(entry).toMatch(/: 54$/);
      expect(errors).toEqual([]);
      await page.context().close();
    });
  }

  // The site list is one card whose dividers sit directly between the rows (owner, 19 Oct): on the
  // iPhone 55px rows, 56px per site and a 223px card; the Mac keeps its 12.5% tighter rows (52px),
  // so 53px per site and a 211px card. Measured in WebKit, the engine of the app's web view.
  for (const [platform, row, card] of [["ios", 55, 223], ["macos", 52, 211]] as const) {
    test(`D04 settings on ${platform}: the site list's dividers sit directly between the rows`, async () => {
      const { page, errors } = await open(false, platform);
      await expect(page.locator(".site-section")).toHaveCount(4);
      if (platform === "macos") await expect(page.locator(".mac-settings")).toHaveCount(1);
      await page.evaluate(() => document.fonts.ready);
      const list = await page.evaluate(() => {
        const group = document.querySelector<HTMLElement>(".service-group")!;
        const sections = [...group.querySelectorAll<HTMLElement>(":scope > .site-section")];
        const rows = sections.map((section) => section.querySelector(".service-row")!.getBoundingClientRect());
        return {
          gap: getComputedStyle(group).rowGap,
          rows: rows.map((r) => Math.round(r.height)),
          steps: rows.slice(1).map((r, i) => Math.round(r.top - rows[i]!.top)),
          card: Math.round(group.getBoundingClientRect().height),
        };
      });
      expect(list.gap).toBe("0px");
      expect(list.rows).toEqual([row, row, row, row]);
      expect(list.steps).toEqual([row + 1, row + 1, row + 1]);
      expect(list.card).toBe(card);
      expect(errors).toEqual([]);
      await page.context().close();
    });
  }


  // ISS-0112 (owner, 20 Oct): the support address under "Contact support" is a plain line people
  // can select and copy, with no Copy button. It is one unit: a click, a double-click on the Mac or
  // a long-press on the iPhone takes the whole address, never only "stillapp.fit" (WebKit's word
  // rule stops at "@" and "."). Measured in WebKit, the engine of the app's web view.
  for (const platform of ["ios", "macos"] as const) {
    test(`D04 settings on ${platform}: one click selects the whole support address`, async () => {
      const { page, errors } = await open(false, platform);
      const help = page.getByRole("region", { name: "Help" });
      const address = help.getByText(SUPPORT_EMAIL, { exact: true });
      await address.scrollIntoViewIfNeeded();
      expect(await address.evaluate((el) => getComputedStyle(el).webkitUserSelect)).toBe("all");
      await address.click();
      expect(await page.evaluate(() => String(getSelection()).trim())).toBe(SUPPORT_EMAIL);
      // The rest of the card keeps its ordinary behavior: the address is the only unit.
      expect(await help.evaluate((el) => getComputedStyle(el).webkitUserSelect)).not.toBe("all");
      // The Help links' invisible hit areas stay off each other's labels and off the address.
      const { heights, stolen } = await helpHitAreas(page);
      for (const name of ["Setup guide", "Privacy policy", "Contact support"])
        expect(heights[name], `${name} hit area on ${platform}`).toBeGreaterThanOrEqual(24);
      expect(stolen, `labels and address taken by another hit area on ${platform}`).toEqual([]);
      expect(errors).toEqual([]);
      await page.context().close();
    });
  }
});
