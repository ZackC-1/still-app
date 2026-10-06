import { expect, test, webkit, type Browser, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS } from "../../packages/shared-types/src/index.js";
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
function nativeHost(showOnboarding: boolean): (message: unknown) => Promise<unknown> {
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
        if (command.action !== "initialize") return JSON.stringify({ status: "unavailable" });
        return JSON.stringify(await writer.initialize(command.ownership ?? "unknown"));
      }
      case "onboardingState":
        return { ok: true, shouldShow: showOnboarding && !onboardingComplete, platform: "ios", osMajorVersion: 26 };
      case "completeOnboarding":
        onboardingComplete = true;
        return { ok: true };
      case "safariSetupState":
        return { ok: true, platform: "ios", extensionStatus: "unknown", enableLocation: "settingsAppStillPage" };
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

  async function open(showOnboarding: boolean): Promise<{ page: Page; errors: string[] }> {
    const context = await browser.newContext({ viewport: { width: 393, height: 759 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.exposeFunction("__stillGuardNative", nativeHost(showOnboarding));
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
});
