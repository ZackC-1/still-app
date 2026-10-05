import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { unmount } from "svelte";
import { requireModernSettings } from "@still/core/storage";
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

const ENV = { atomicSettingsFlag: "true", supabaseUrl: undefined, supabaseAnonKey: undefined };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const writes = (kinds: unknown[]) => kinds.filter((kind) => UNPROMPTED_WRITES.includes(kind as string));

afterEach(async () => {
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
    for (const word of ["$", "Purchase", "Restore"]) expect(text).not.toContain(word);
    // Owner decision 24: "Still Pro" appears only as the inert locked-row label beside a lock.
    const locks = [...document.querySelectorAll<HTMLElement>(".lock-pro")];
    expect(locks.length).toBeGreaterThan(0);
    for (const lock of locks) {
      expect(lock.getAttribute("aria-disabled")).toBe("true");
      expect(lock.textContent).toBe("Still Pro");
    }
    expect(text.length - text.replaceAll("Still Pro", "").length).toBe(locks.length * "Still Pro".length);
    expect(screen.queryByRole("button", { name: /Get Still Pro/ })).toBeNull();
  });
});
