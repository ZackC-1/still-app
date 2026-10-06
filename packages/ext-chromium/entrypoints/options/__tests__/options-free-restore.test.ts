import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { DEFAULT_SETTINGS, PAID_TIER_ENABLED } from "@still/shared-types";
import { ChromeStorageAdapter, createSettingsIntentRouter } from "@still/core/storage";
import { CONSENT_KEY } from "@still/core/analytics";
import { ANALYTICS_MESSAGE_KIND } from "../../../lib/analytics.js";
// Only the browser boundary is synthetic; the factory, controller, sign-in sheet, settings page and
// the Restore wrapper are the actual ones the options page mounts.
vi.mock("wxt/browser", () => ({
  get browser() {
    return globalThis.chrome;
  },
}));
import OptionsApp from "../OptionsApp.svelte";
import RestoreSettings from "../RestoreSettings.svelte";

// Owner decisions 62 and 73 (option A): a plain "Restore purchase" link on the Chrome/Firefox
// settings page, V3 new-sync builds only. Signed out it goes through the normal email-code sign-in
// first; then it only checks. These tests mount the real options page against a synthetic
// background that records every message it is sent.

beforeAll(async () => {
  await import("../../../../core/src/ui/v3/ExtensionSettings.svelte");
  await import("../RestoreSettings.svelte");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

type Answer = "entitled" | "not-entitled" | "unknown" | "auth-required" | "signed-out";
const RESTORED = "Still Pro is restored on this device.";
const NOTHING = "No Still Pro purchase was found for this account.";
const FAILED = "We couldn't finish checking. Nothing changed.";
/** Every purchase-side session action. The Restore flow must never send one. */
const PURCHASE_ACTIONS = ["createCheckout", "setPurchaseIntent", "setCheckoutPending", "reconcile"];
/** The normal sign-in flow's existing events; the Restore flow adds none of its own. */
const SIGN_IN_EVENTS = ["opened", "sign_in_opened", "code_requested", "signed_in"];

async function installBrowser(options: { signedIn: boolean; answers?: (Answer | Error | Promise<Answer>)[] }) {
  const store: Record<string, unknown> = {
    "still:settings": { settings: structuredClone(DEFAULT_SETTINGS), syncMetadata: null },
    [CONSENT_KEY]: false,
  };
  const listeners = new Set<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void>();
  const origin = "chrome-extension://synthetic/";
  const set = async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) {
      const oldValue = store[key];
      store[key] = structuredClone(value);
      for (const listener of [...listeners])
        listener({ [key]: { oldValue, newValue: structuredClone(value) } }, "local");
    }
  };
  let userId: string | null = options.signedIn ? "user-a" : null;
  const answers = [...(options.answers ?? [])];
  const messages: Record<string, unknown>[] = [];
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    messages.push(structuredClone(message));
    if (message.kind === ANALYTICS_MESSAGE_KIND) return undefined;
    if (message.kind === "still:settings-intent")
      return new Promise<unknown>((resolve) => router(message, { id: "synthetic", url: origin + "options.html" }, resolve));
    switch (message.action) {
      case "getState":
        return { userId, entitled: false, pendingOtp: null, checkoutPending: null };
      case "getSyncStatus":
        return userId
          ? { accountId: userId, email: "person@still.test", lastSyncedAt: 1, pendingUpload: false, cloudReachable: true, updatedAt: 1 }
          : null;
      case "requestCode":
        return { kind: "sent" };
      case "verifyCode":
        userId = "user-a";
        return { kind: "verified", userId, email: "person@still.test" };
      case "setPendingOtp":
        return "ok";
      case "restore": {
        const next = answers.shift();
        if (next === undefined) throw new Error("unexpected restore");
        if (next instanceof Error) throw next;
        return next;
      }
      default:
        return undefined;
    }
  });
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: structuredClone(store[key]) } : {}),
        set,
      },
      onChanged: {
        addListener: (listener: Parameters<typeof listeners.add>[0]) => listeners.add(listener),
        removeListener: (listener: Parameters<typeof listeners.add>[0]) => listeners.delete(listener),
      },
    },
    runtime: {
      id: "synthetic",
      getURL: (path = "") => origin + path.replace(/^\//, ""),
      sendMessage,
      openOptionsPage: vi.fn(async () => {}),
    },
    tabs: { create: vi.fn(async () => ({ id: 1 })) },
  });
  const authority = new ChromeStorageAdapter({ authority: true });
  const router = createSettingsIntentRouter(
    (intent) => authority.commitIntent(intent),
    "synthetic",
    origin,
    (record) => authority.set(record),
  );
  await authority.initializeAtomic("never-linked");
  const actions = () => messages.map((message) => message.action).filter((action) => typeof action === "string");
  const restores = () => messages.filter((message) => message.action === "restore");
  const tracked = () =>
    messages.filter((message) => message.kind === ANALYTICS_MESSAGE_KIND && message.action === "track").map((message) => message.name);
  return { messages, actions, restores, tracked, store };
}

function v3Build() {
  vi.stubEnv("VITE_SUPABASE_URL", "https://synthetic.invalid");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "synthetic-public-key");
  vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "true");
}

async function settingsPage() {
  render(OptionsApp);
  await waitFor(() => expect(screen.getByRole("button", { name: "YouTube Blocker" })).toBeTruthy());
}

const link = () => screen.getByRole("button", { name: "Restore purchase" });

function expectNoPurchase(f: Awaited<ReturnType<typeof installBrowser>>) {
  expect(f.actions().filter((action) => PURCHASE_ACTIONS.includes(action))).toEqual([]);
  expect(document.body.textContent ?? "").not.toMatch(/Get Still Pro|Buy|\$|€|£|Opening checkout/);
  expect(screen.queryByRole("dialog", { name: "Still Pro" })).toBeNull();
}

describe("V3 new-sync settings page: Restore purchase", () => {
  it("signed in, past buyer: one check, the restored line, nothing offered", async () => {
    expect(PAID_TIER_ENABLED).toBe(false);
    const f = await installBrowser({ signedIn: true, answers: ["entitled"] });
    v3Build();
    await settingsPage();
    await waitFor(() => expect(screen.getByText("person@still.test")).toBeTruthy());
    const before = f.tracked();
    await fireEvent.click(link());
    await waitFor(() => expect(screen.getByText(RESTORED)).toBeTruthy());
    expect(f.restores()).toEqual([{ kind: "still:session", action: "restore" }]);
    expect(f.tracked()).toEqual(before);
    expectNoPurchase(f);
    // Nothing unlocks while paid is off: the Pro rows stay locked and inert.
    await fireEvent.click(screen.getByRole("button", { name: "YouTube Blocker" }));
    const locks = screen.getAllByRole("button", { name: "Still Pro" });
    expect(locks.length).toBeGreaterThan(0);
    await fireEvent.click(locks[0]!);
    expectNoPurchase(f);
  });

  it("signed in, no purchase: the existing nothing-found wording", async () => {
    const f = await installBrowser({ signedIn: true, answers: ["not-entitled"] });
    v3Build();
    await settingsPage();
    await waitFor(() => expect(screen.getByText("person@still.test")).toBeTruthy());
    await fireEvent.click(link());
    await waitFor(() => expect(screen.getByText(NOTHING)).toBeTruthy());
    expect(f.restores()).toHaveLength(1);
    expectNoPurchase(f);
  });

  it("signed out: the normal email-code sign-in first, then the check", async () => {
    const f = await installBrowser({ signedIn: false, answers: ["entitled"] });
    v3Build();
    await settingsPage();
    await fireEvent.click(link());
    expect(f.restores()).toEqual([]);
    const consent = await screen.findByRole("dialog", { name: "Your email is only for sign-in" });
    await fireEvent.click(within(consent).getByRole("button", { name: "Continue" }));
    await fireEvent.input(screen.getByLabelText("Email address"), { target: { value: "person@still.test" } });
    await fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    const code = await screen.findByLabelText("6-digit code");
    expect(f.restores()).toEqual([]);
    await fireEvent.input(code, { target: { value: "123456" } });
    await fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
    await waitFor(() => expect(screen.getByText(RESTORED)).toBeTruthy());
    expect(f.restores()).toHaveLength(1);
    expect(f.actions().indexOf("verifyCode")).toBeLessThan(f.actions().indexOf("restore"));
    expect(f.tracked().every((name) => SIGN_IN_EVENTS.includes(String(name)))).toBe(true);
    expectNoPurchase(f);
  });

  it("signed out, sheet dismissed: no check and nothing shown", async () => {
    const f = await installBrowser({ signedIn: false, answers: [] });
    v3Build();
    await settingsPage();
    await fireEvent.click(link());
    const consent = await screen.findByRole("dialog", { name: "Your email is only for sign-in" });
    await fireEvent.click(within(consent).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.restores()).toEqual([]);
    expect(screen.queryByText(RESTORED)).toBeNull();
    expect((link() as HTMLButtonElement).disabled).toBe(false);
    expectNoPurchase(f);
  });

  it("an error shows the existing failed wording; Try again checks once more", async () => {
    const f = await installBrowser({ signedIn: true, answers: [new Error("torn"), "unknown", "entitled"] });
    v3Build();
    await settingsPage();
    await waitFor(() => expect(screen.getByText("person@still.test")).toBeTruthy());
    await fireEvent.click(link());
    await waitFor(() => expect(screen.getByText(FAILED)).toBeTruthy());
    expect((link() as HTMLButtonElement).disabled).toBe(true);
    // Offline: the background could not reach the server, so it answers unknown.
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(f.restores()).toHaveLength(2));
    await waitFor(() => expect(screen.getByText(FAILED)).toBeTruthy());
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText(RESTORED)).toBeTruthy());
    expect(f.restores()).toHaveLength(3);
    expectNoPurchase(f);
  });

  it("a double tap sends one check", async () => {
    let answer!: (value: Answer) => void;
    const slow = new Promise<Answer>((resolve) => (answer = resolve));
    const f = await installBrowser({ signedIn: true, answers: [slow, "entitled"] });
    v3Build();
    await settingsPage();
    await waitFor(() => expect(screen.getByText("person@still.test")).toBeTruthy());
    const target = link();
    target.click();
    target.click();
    await fireEvent.click(target);
    await waitFor(() => expect(screen.getByText("Checking for Still Pro purchases…")).toBeTruthy());
    expect((link() as HTMLButtonElement).disabled).toBe(true);
    answer("entitled");
    await waitFor(() => expect(screen.getByText(RESTORED)).toBeTruthy());
    expect(f.restores()).toHaveLength(1);
  });
});

describe("Restore purchase is absent outside V3 new-sync builds", () => {
  it("configured 2.x build: the legacy settings page has no Restore purchase", async () => {
    const f = await installBrowser({ signedIn: true });
    vi.stubEnv("VITE_SUPABASE_URL", "https://synthetic.invalid");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "synthetic-public-key");
    vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "");
    render(OptionsApp);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Still on/off" })).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("button", { name: "Restore purchase" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
    expect(f.restores()).toEqual([]);
  });

  it("unconfigured build (no sign-in server): the V3 page has no Restore purchase", async () => {
    const f = await installBrowser({ signedIn: false });
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
    await settingsPage();
    expect(screen.queryByRole("button", { name: "Restore purchase" })).toBeNull();
    expect(f.restores()).toEqual([]);
  });
});

describe("Restore wrapper forwarding", () => {
  it("forwards every settings prop it does not own", async () => {
    // The wrapper names each ExtensionSettings prop (no spread). This source check fails when a
    // prop is added to ExtensionSettingsProps without being forwarded here.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const presentation = readFileSync(
      resolve(import.meta.dirname, "../../../../core/src/ui/v3/extension-settings-presentation.ts"),
      "utf8",
    );
    const wrapper = readFileSync(resolve(import.meta.dirname, "../RestoreSettings.svelte"), "utf8");
    const body = presentation.slice(presentation.indexOf("export interface ExtensionSettingsProps"));
    const block = body.slice(0, body.indexOf("\n}\n"));
    const pick = block.slice(block.indexOf("Pick<"), block.indexOf("> {"));
    const picked = [...pick.matchAll(/\|\s*"(\w+)"/g)].map((m) => m[1]!);
    const own = [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
    const props = [...new Set([...picked, ...own])];
    expect(props).toEqual(expect.arrayContaining(["settings", "sync", "restore", "onRestore", "help"]));
    const markup = wrapper.slice(wrapper.lastIndexOf("<ExtensionSettings"));
    for (const prop of props)
      expect(markup, prop).toMatch(new RegExp(`\\{${prop}\\}|\\b${prop}=`));
    expect(RestoreSettings).toBeTypeOf("function");
  });
});

describe("the build-time Restore gate", () => {
  it("is on exactly for configured builds that run the V3 interface (new sync), never 2.x or unconfigured", async () => {
    // The gate must stay an inline import.meta.env expression so the bundler folds it away in
    // configured 2.x builds. This evaluates that exact expression over every build input combination.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { runsV3Interface } = await import("../../../wxt.config.js");
    const source = readFileSync(resolve(import.meta.dirname, "../OptionsApp.svelte"), "utf8");
    const match = /const freeRestore = Boolean\(([\s\S]*?)\);/.exec(source);
    expect(match).not.toBeNull();
    const expression = match![1]!.replaceAll("import.meta.env", "env");
    expect(expression).not.toMatch(/import\.meta|purchase|controller/);
    const gate = new Function("env", `return Boolean(${expression});`) as (env: Record<string, string | undefined>) => boolean;
    for (const url of [undefined, "", "https://synthetic.invalid"])
      for (const key of [undefined, "", "synthetic-public-key"])
        for (const modern of [undefined, "", "false", "true"]) {
          const env = { VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: key, VITE_MODERN_SETTINGS_SYNC_ENABLED: modern };
          const configured = Boolean(url) && Boolean(key);
          expect(gate(env), JSON.stringify(env)).toBe(configured && runsV3Interface(env));
        }
  });
});
