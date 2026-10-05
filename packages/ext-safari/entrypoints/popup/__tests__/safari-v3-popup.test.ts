import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { unmount } from "svelte";
import { requireModernSettings } from "@still/core/storage";
import { startSafariV3Popup } from "../v3.js";
import { installSafari, UNPROMPTED_WRITES, type SavedShape } from "./safari-native.fixture.js";

const mounted = vi.hoisted(() => ({ instances: [] as Record<string, unknown>[] }));
vi.mock("svelte", async (importOriginal) => {
  const real = await importOriginal<typeof import("svelte")>();
  return {
    ...real,
    mount: (component: Parameters<typeof real.mount>[0], options: Parameters<typeof real.mount>[1]) => {
      const instance = real.mount(component, options);
      mounted.instances.push(instance);
      return instance;
    },
  };
});

const ENV = { atomicSettingsFlag: "true", supabaseUrl: undefined, supabaseAnonKey: undefined };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  for (const instance of mounted.instances.splice(0)) await unmount(instance);
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(saved: SavedShape, options: { platform?: string; signedIn?: boolean; projection?: boolean; down?: boolean } = {}) {
  const f = await installSafari({ saved, ...options });
  if (options.down) f.setNativeDown(true);
  document.body.innerHTML = '<div id="app"></div>';
  const load = vi.fn(() => import("../v3-mount.js"));
  const mode = await startSafariV3Popup({ env: ENV, load });
  return { f, load, mode };
}

const writes = (kinds: unknown[]) => kinds.filter((kind) => UNPROMPTED_WRITES.includes(kind as string));
const text = () => document.body.textContent ?? "";

describe("Safari V3 popup: runtime record gate", () => {
  it.each([
    ["legacy record", "legacy", {}],
    ["nothing saved", "absent", {}],
    ["app unreachable and no atomic copy in browser storage", "atomic", { down: true }],
  ] as const)("%s keeps today's legacy popup and writes nothing", async (_name, saved, options) => {
    const { f, load, mode } = await open(saved, options);
    expect(mode).toBe("legacy");
    // The V3 components and their global stylesheet are never even loaded.
    expect(load).not.toHaveBeenCalled();
    expect(document.querySelector(".still-ui")).toBeNull();
    expect(writes(f.nativeKinds())).toEqual([]);
    expect(f.store["still:settings"]).toBeUndefined();
  });

  it("the app's atomic record mounts V3, also from the retained copy while the app is unreachable", async () => {
    const { load, mode } = await open("atomic", { projection: true, down: true });
    expect(mode).toBe("v3");
    expect(load).toHaveBeenCalledOnce();
    // Last-known choices, held: never a fresh confirmation, and recovery is offered.
    await waitFor(() => expect(screen.getByText("Settings are unavailable.")).toBeTruthy());
    expect(screen.getByRole("switch", { name: "Still" }).getAttribute("aria-disabled")).toBe("true");
  });
});

describe("Safari V3 popup: surfaces", () => {
  it("iOS gets MobilePopup with saved choices exactly as stored, and opening writes nothing", async () => {
    const { f, mode } = await open("atomic");
    expect(mode).toBe("v3");
    const before = structuredClone(await f.nativeRecord());
    await waitFor(() => expect(screen.getByRole("button", { name: "Settings. Opens Still settings." })).toBeTruthy());
    expect(screen.getByRole("switch", { name: "TikTok website" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Still on YouTube" }).getAttribute("aria-checked")).toBe("true");
    for (let i = 0; i < 5; i++) await flush();
    expect(writes(f.nativeKinds())).toEqual([]);
    expect(await f.nativeRecord()).toEqual(before);
    await fireEvent.click(screen.getByRole("button", { name: "Settings. Opens Still settings." }));
    expect(f.openOptionsPage).toHaveBeenCalledOnce();
  });

  it("macOS gets DesktopPopup with its D01 reference label unchanged (owner copy question)", async () => {
    await open("atomic", { platform: "mac" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Settings. Find Still in Chrome." })).toBeTruthy());
    expect(screen.getByRole("heading", { name: "Still is active" })).toBeTruthy();
  });

  it("an unreadable platform falls back to the mobile popup", async () => {
    const f = await installSafari({ saved: "atomic" });
    document.body.innerHTML = '<div id="app"></div>';
    await startSafariV3Popup({ env: ENV, platform: () => Promise.reject(new Error("no")) });
    await waitFor(() => expect(screen.getByRole("button", { name: "Settings. Opens Still settings." })).toBeTruthy());
    expect(writes(f.nativeKinds())).toEqual([]);
  });
});

describe("Safari V3 popup: saving", () => {
  it.each(["ios", "mac"])("%s: one switch is exactly one native intent, mirrored for blocking and reported once", async (platform) => {
    const { f } = await open("atomic", { platform });
    const instagram = await screen.findByRole("switch", { name: "Still on Instagram" });
    await waitFor(() => expect(instagram.getAttribute("aria-disabled")).toBeNull());
    await fireEvent.click(instagram);
    await waitFor(() => expect(f.nativeKinds().filter((k) => k === "settingsIntent")).toHaveLength(1));
    const intent = f.native.find((m) => m.kind === "settingsIntent")!;
    expect(intent).toMatchObject({ path: "services.instagram", value: false });
    expect(f.nativeKinds()).not.toContain("set");
    expect(requireModernSettings((await f.nativeRecord())!).services.instagram).toBe(false);
    // The committed record reaches browser.storage, which is what the content scripts read.
    await waitFor(() =>
      expect((f.store["still:settings"] as { settings: { services: { instagram: boolean } } }).settings.services.instagram).toBe(false),
    );
    await waitFor(() =>
      expect(f.messages.filter((m) => m.event === "service_toggled" || (m as { name?: string }).name === "service_toggled")).toHaveLength(1),
    );
    // The saved TikTok Off is untouched by an unrelated switch.
    expect(requireModernSettings((await f.nativeRecord())!).services.tiktok).toBe(false);
  });

  it("app unreachable at save: switches held, recovery offered, Try again only reads", async () => {
    const { f } = await open("atomic");
    const instagram = await screen.findByRole("switch", { name: "Still on Instagram" });
    await waitFor(() => expect(instagram.getAttribute("aria-disabled")).toBeNull());
    f.setNativeDown(true);
    await fireEvent.click(instagram);
    await waitFor(() => expect(screen.getByText("Settings are unavailable.")).toBeTruthy());
    expect(screen.getByRole("switch", { name: "Still" }).getAttribute("aria-disabled")).toBe("true");
    // The failed action permits one automatic read (still failing); let it settle first, since a
    // Try again during it joins that same single-flight read rather than starting another.
    for (let i = 0; i < 5; i++) await flush();
    const intents = f.nativeKinds().filter((k) => k === "settingsIntent").length;
    const gets = f.nativeKinds().filter((k) => k === "get").length;
    f.setNativeDown(false);
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText("Settings are unavailable.")).toBeNull());
    expect(f.nativeKinds().filter((k) => k === "settingsIntent")).toHaveLength(intents);
    // At least the one recovery read; account-status polling may add its own reads meanwhile.
    expect(f.nativeKinds().filter((k) => k === "get").length).toBeGreaterThanOrEqual(gets + 1);
    expect(screen.getByRole("switch", { name: "Still on Instagram" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("Safari V3 popup: what is never offered", () => {
  it.each(["ios", "mac"])("%s signed in: the account is shown, but no account action the app owns", async (platform) => {
    await open("atomic", { platform, signedIn: true });
    await waitFor(() => expect(screen.getByText("person@example.invalid")).toBeTruthy());
    for (const name of ["Sign out", "Delete account", "Sign in", "Try again"])
      expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it.each(["ios", "mac"])("%s: no price, purchase, paywall or Open Still route", async (platform) => {
    await open("atomic", { platform });
    await screen.findByRole("switch", { name: "Still on Instagram" });
    for (const word of ["$", "Purchase", "Still Pro", "Open the Still app", "Restore"]) expect(text()).not.toContain(word);
  });
});

describe("Safari V3 popup: a failed mount", () => {
  const tracked = (f: Awaited<ReturnType<typeof installSafari>>, name: string) =>
    f.messages.filter((m) => m.action === "track" && m.name === name);

  it("a mounted popup reports opened exactly once", async () => {
    const { f } = await open("atomic");
    await screen.findByRole("switch", { name: "Still on Instagram" });
    await waitFor(() => expect(tracked(f, "opened")).toHaveLength(1));
  });

  it("stops everything it started, clears the page and hands over to legacy", async () => {
    const f = await installSafari({ saved: "atomic", signedIn: true });
    document.body.innerHTML = '<div id="app"></div>';
    const mode = await startSafariV3Popup({
      env: ENV,
      load: async () => ({
        mountSafariV3Popup(target: HTMLElement) {
          target.append(document.createElement("section"));
          throw new Error("mount failed");
        },
      }),
    });
    expect(mode).toBe("legacy");
    expect(document.getElementById("app")!.childNodes).toHaveLength(0);
    const polls = f.nativeKinds().filter((k) => k === "getAccountSyncStatus").length;
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    // Account polling (every 2s) was stopped, no opened event was sent, nothing was written.
    expect(f.nativeKinds().filter((k) => k === "getAccountSyncStatus")).toHaveLength(polls);
    expect(tracked(f, "opened")).toHaveLength(0);
    expect(writes(f.nativeKinds())).toEqual([]);
  });

  it("a component module that fails to load hands over to legacy before anything starts", async () => {
    const f = await installSafari({ saved: "atomic" });
    document.body.innerHTML = '<div id="app"></div>';
    const mode = await startSafariV3Popup({ env: ENV, load: () => Promise.reject(new Error("chunk")) });
    expect(mode).toBe("legacy");
    expect(f.messages.filter((m) => m.kind === "reconcile")).toHaveLength(0);
    expect(f.nativeKinds().filter((k) => k === "getAccountSyncStatus")).toHaveLength(0);
  });
});
