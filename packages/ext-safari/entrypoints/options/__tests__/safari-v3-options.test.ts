import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { unmount } from "svelte";
import { requireModernSettings } from "@still/core/storage";
import { SettingsCache } from "@still/core/storage";
import { EntitlementCache } from "@still/core/entitlement";
import { startSafariV3Options } from "../v3.js";
import { installSafari, UNPROMPTED_WRITES, type SavedShape } from "../../popup/__tests__/safari-native.fixture.js";

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

// Lets one test make the composition itself throw (the binding is its last step).
const composeGate = vi.hoisted(() => ({ failBinding: false }));
vi.mock("../../../../core/src/ui/v3/desktop-popup-binding.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../../core/src/ui/v3/desktop-popup-binding.js")>();
  return {
    ...real,
    createDesktopPopupBinding: (...args: Parameters<typeof real.createDesktopPopupBinding>) => {
      if (composeGate.failBinding) throw new Error("binding failed");
      return real.createDesktopPopupBinding(...args);
    },
  };
});

const ENV = { atomicSettingsFlag: "true", supabaseUrl: undefined, supabaseAnonKey: undefined };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const writes = (kinds: unknown[]) => kinds.filter((kind) => UNPROMPTED_WRITES.includes(kind as string));

afterEach(async () => {
  composeGate.failBinding = false;
  for (const instance of mounted.instances.splice(0)) await unmount(instance);
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(saved: SavedShape, signedIn = false) {
  const f = await installSafari({ saved, signedIn });
  document.body.innerHTML = '<div id="app"></div>';
  const load = vi.fn(() => import("../v3-mount.js"));
  const mode = await startSafariV3Options({ env: ENV, load });
  return { f, load, mode };
}

describe("Safari V3 settings page", () => {
  it.each(["legacy", "absent"] as const)("a %s record keeps today's settings page and writes nothing", async (saved) => {
    const { f, load, mode } = await open(saved);
    expect(mode).toBe("legacy");
    expect(load).not.toHaveBeenCalled();
    expect(writes(f.nativeKinds())).toEqual([]);
  });

  it("the app's atomic record: saved choices as stored, opening writes nothing, one switch is one intent", async () => {
    const { f, mode } = await open("atomic");
    expect(mode).toBe("v3");
    const tiktok = await screen.findByRole("switch", { name: "TikTok website" });
    expect(tiktok.getAttribute("aria-checked")).toBe("false");
    for (let i = 0; i < 5; i++) await flush();
    expect(writes(f.nativeKinds())).toEqual([]);
    const facebook = screen.getByRole("switch", { name: "Still on Facebook" });
    await waitFor(() => expect(facebook.getAttribute("aria-disabled")).toBeNull());
    await fireEvent.click(facebook);
    await waitFor(() => expect(f.nativeKinds().filter((k) => k === "settingsIntent")).toHaveLength(1));
    expect(f.native.find((m) => m.kind === "settingsIntent")).toMatchObject({ path: "services.facebook", value: false });
    expect(f.nativeKinds()).not.toContain("set");
    const saved = requireModernSettings((await f.nativeRecord())!);
    expect(saved.services.facebook).toBe(false);
    expect(saved.services.tiktok).toBe(false);
  });

  it("signed out: no Sign in button (this build cannot sign in; the app owns the account)", async () => {
    await open("atomic");
    await screen.findByRole("switch", { name: "Still on Facebook" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Settings sync" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("a failed mount stops what it started, clears the page and hands over to legacy", async () => {
    const f = await installSafari({ saved: "atomic", signedIn: true });
    document.body.innerHTML = '<div id="app"></div>';
    const mode = await startSafariV3Options({
      env: ENV,
      load: async () => ({
        mountSafariV3Options() {
          throw new Error("mount failed");
        },
      }),
    });
    expect(mode).toBe("legacy");
    expect(document.getElementById("app")!.childNodes).toHaveLength(0);
    const polls = f.nativeKinds().filter((k) => k === "getAccountSyncStatus").length;
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(f.nativeKinds().filter((k) => k === "getAccountSyncStatus")).toHaveLength(polls);
    expect(f.messages.filter((m) => m.action === "track" && m.name === "opened")).toHaveLength(0);
  });

  it("signed in: the account is shown, but no sign-out, delete or sign-in (the app owns them)", async () => {
    await open("atomic", true);
    await waitFor(() => expect(screen.getByText("person@example.invalid")).toBeTruthy());
    for (const name of ["Sign out", "Delete account", "Sign in"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("Setup guide opens the website guide; no price, purchase or restore", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    await open("atomic");
    await screen.findByRole("switch", { name: "Still on Facebook" });
    await fireEvent.click(screen.getByRole("button", { name: /Setup guide/ }));
    expect(opened).toHaveBeenCalledWith("https://stillapp.fit/setup/", "_blank", "noopener,noreferrer");
    const text = document.body.textContent ?? "";
    for (const word of ["$", "Purchase", "Still Pro", "Restore"]) expect(text).not.toContain(word);
  });
});

describe("Safari V3 settings page: stylesheets and the first read", () => {
  const links = () => [...document.head.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href"));
  const v3Link = () => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "v3-components.css";
    document.head.append(link);
  };
  afterEach(() => {
    document.head.innerHTML = "";
  });

  it("a failed mount removes the V3 stylesheets Vite preloaded and keeps the page's own", async () => {
    await installSafari({ saved: "atomic" });
    document.body.innerHTML = '<div id="app"></div>';
    document.head.innerHTML = '<link rel="stylesheet" href="legacy.css">';
    const mode = await startSafariV3Options({
      env: ENV,
      load: async () => {
        v3Link(); // what the dynamic import does before the components exist
        return {
          mountSafariV3Options() {
            throw new Error("mount failed");
          },
        };
      },
    });
    expect(mode).toBe("legacy");
    expect(links()).toEqual(["legacy.css"]);
  });

  it("a component module that fails to load also leaves no V3 stylesheet behind", async () => {
    await installSafari({ saved: "atomic" });
    document.body.innerHTML = '<div id="app"></div>';
    document.head.innerHTML = '<link rel="stylesheet" href="legacy.css">';
    const mode = await startSafariV3Options({
      env: ENV,
      load: async () => {
        v3Link();
        throw new Error("chunk");
      },
    });
    expect(mode).toBe("legacy");
    expect(links()).toEqual(["legacy.css"]);
  });

  it("a mounted V3 screen keeps its stylesheets", async () => {
    await installSafari({ saved: "atomic" });
    document.body.innerHTML = '<div id="app"></div>';
    const real = await import("../v3-mount.js");
    const mode = await startSafariV3Options({
      env: ENV,
      load: async () => {
        v3Link();
        return real;
      },
    });
    expect(mode).toBe("v3");
    expect(links()).toEqual(["v3-components.css"]);
  });

  it("shows \"Checking sync…\" until the first read answers, never \"Settings are unavailable.\"", async () => {
    const f = await installSafari({ saved: "atomic" });
    const record = await f.nativeRecord();
    f.holdReads();
    document.body.innerHTML = '<div id="app"></div>';
    const mode = await startSafariV3Options({
      env: ENV,
      probe: async () => record,
      load: () => import("../v3-mount.js"),
    });
    expect(mode).toBe("v3");
    expect(screen.getByText("Checking sync…")).toBeTruthy();
    expect(screen.queryByText("Settings are unavailable.")).toBeNull();
    for (let i = 0; i < 5; i++) await flush();
    expect(screen.getByText("Checking sync…")).toBeTruthy();
    f.releaseReads();
    await screen.findByRole("switch", { name: "Still on Instagram" });
    expect(screen.queryByText("Checking sync…")).toBeNull();
  });
});

describe("startSafariV3Options: a failed mount stops every watcher", () => {
  it("stops the settings watch, the entitlement watch and the binding, and leaves no storage listener", async () => {
    const f = await installSafari({ saved: "atomic", signedIn: true });
    document.body.innerHTML = '<div id="app"></div>';
    const stops = { settings: vi.fn(), entitlement: vi.fn(), binding: vi.fn() };
    const watchSettings = SettingsCache.prototype.watch;
    vi.spyOn(SettingsCache.prototype, "watch").mockImplementation(function (this: SettingsCache) {
      const stop = watchSettings.call(this);
      return () => {
        stops.settings();
        stop();
      };
    });
    const watchEntitlement = EntitlementCache.prototype.watch;
    vi.spyOn(EntitlementCache.prototype, "watch").mockImplementation(function (this: EntitlementCache) {
      const stop = watchEntitlement.call(this);
      return () => {
        stops.entitlement();
        stop();
      };
    });
    let listenersWhileMounting = 0;
    const mode = await startSafariV3Options({
      env: ENV,
      load: async () => ({
        mountSafariV3Options(_target: HTMLElement, composition: { binding: { stop(): void } }) {
          const stop = composition.binding.stop.bind(composition.binding);
          composition.binding.stop = () => {
            stops.binding();
            stop();
          };
          listenersWhileMounting = f.storageListenerCount();
          throw new Error("mount failed");
        },
      }),
    });
    expect(mode).toBe("legacy");
    expect(listenersWhileMounting).toBeGreaterThan(0); // they really were running
    expect(stops.settings).toHaveBeenCalledOnce();
    expect(stops.entitlement).toHaveBeenCalledOnce();
    expect(stops.binding).toHaveBeenCalledOnce();
    expect(f.storageListenerCount()).toBe(0);
  });
});

describe("startSafariV3Options: the composition itself throws", () => {
  it("hands over to legacy, stops what it started and leaves only the page's own stylesheet", async () => {
    const f = await installSafari({ saved: "atomic", signedIn: true });
    document.body.innerHTML = '<div id="app"></div>';
    document.head.innerHTML = '<link rel="stylesheet" href="legacy.css">';
    composeGate.failBinding = true;
    const mount = vi.fn();
    const mode = await startSafariV3Options({
      env: ENV,
      load: async () => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "v3-components.css";
        document.head.append(link);
        return { mountSafariV3Options: mount };
      },
    });
    expect(mode).toBe("legacy");
    expect(mount).not.toHaveBeenCalled();
    expect([...document.head.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href"))).toEqual([
      "legacy.css",
    ]);
    expect(f.storageListenerCount()).toBe(0);
    document.head.innerHTML = "";
  });
});
