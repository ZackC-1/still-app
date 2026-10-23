import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/svelte";
import { unmount } from "svelte";
import { startSafariV3Options } from "../v3.js";
import { installSafari } from "../../popup/__tests__/safari-native.fixture.js";

// ISS-0032 (16:05 addition): the Safari settings page offers Still Pro the way the Safari popup
// does, by opening the Still app (no price, no purchase in Safari). The shared settings component
// is replaced by a recorder so the Pro action can be driven without a paid build; the hand-off
// runs through the real v3-mount wiring and the synthetic browser/native port.

const seen = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock("@still/core/ui/v3/ExtensionSettings.svelte", () => ({
  default: (_anchor: unknown, props: Record<string, unknown>) => {
    seen.props.push(props);
  },
}));

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

const ENV = { atomicSettingsFlag: "true", modernSyncFlag: undefined, supabaseUrl: undefined, supabaseAnonKey: undefined };

afterEach(async () => {
  for (const instance of mounted.instances.splice(0)) await unmount(instance);
  seen.props.splice(0);
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settingsPage(platform: "mac" | "ios") {
  const f = await installSafari({ saved: "atomic", platform });
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  document.body.innerHTML = '<div id="app"></div>';
  expect(await startSafariV3Options({ env: ENV, platform: async () => platform })).toBe("v3");
  await waitFor(() => expect(seen.props.length).toBeGreaterThan(0));
  return { f, close, props: seen.props.at(-1)! };
}

describe("Safari settings page: the Still Pro hand-off", () => {
  it("Mac: supplies proHandoff, which opens still://pro through the app and keeps the settings tab open", async () => {
    const { f, close, props } = await settingsPage("mac");
    expect(typeof props.proHandoff).toBe("function");
    // No price or purchase producer in Safari (App Store Review Guidelines 3.1.1, 3.1.3).
    expect(props.pro).toBeUndefined();
    (props.proHandoff as () => void)();
    await waitFor(() => expect(f.native.filter((m) => m.kind === "openAppRoute")).toEqual([{ kind: "openAppRoute", route: "pro" }]));
    expect(f.createTab).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("iPhone: opens the fixed still://pro link in a Safari tab", async () => {
    const { f, close, props } = await settingsPage("ios");
    (props.proHandoff as () => void)();
    await waitFor(() => expect(f.createTab).toHaveBeenCalledTimes(1));
    expect(f.createTab.mock.calls).toEqual([[{ url: "still://pro" }]]);
    expect(f.nativeKinds()).not.toContain("openAppRoute");
    expect(close).not.toHaveBeenCalled();
  });
});

// Copy audit (22 Oct 2026): signed out, the settings page's sync card showed only its heading. It
// now shows the Safari popups' signed-out pattern, and its Sign in opens the Still app's sync
// screen (the app owns the account on Safari); nothing signs in here.
describe("Safari settings page: the signed-out sync card's Sign in", () => {
  it("Mac: Sign in opens still://sync through the app and keeps the settings tab open", async () => {
    const { f, close, props } = await settingsPage("mac");
    const sync = props.sync as { account?: unknown; onSignIn?: () => void; appHandoff?: boolean };
    expect(sync.account).toBeUndefined();
    expect(sync.appHandoff).toBe(true);
    sync.onSignIn?.();
    await waitFor(() => expect(f.native.filter((m) => m.kind === "openAppRoute")).toEqual([{ kind: "openAppRoute", route: "sync" }]));
    expect(f.createTab).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("iPhone: Sign in opens the fixed still://sync link in a Safari tab", async () => {
    const { f, props } = await settingsPage("ios");
    (props.sync as { onSignIn: () => void }).onSignIn();
    await waitFor(() => expect(f.createTab).toHaveBeenCalledTimes(1));
    expect(f.createTab.mock.calls).toEqual([[{ url: "still://sync" }]]);
  });
});
