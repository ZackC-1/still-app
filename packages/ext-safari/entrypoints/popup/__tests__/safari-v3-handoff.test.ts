import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/svelte";
import { unmount } from "svelte";
import { startSafariV3Popup } from "../v3.js";
import { installSafari } from "./safari-native.fixture.js";

// What the Safari popup host hands the shared popup: appHandoff, and onSeePro / onSignIn that open
// the Still app. The shared popups are replaced by a recorder so the Pro action can be driven
// without a paid build; the hand-off itself runs through the real v3-mount wiring and the
// synthetic browser/native port (Mac: the native openAppRoute lane; iPhone: a Safari tab).

const seen = vi.hoisted(() => ({ props: [] as { name: string; props: Record<string, unknown> }[] }));
function recorder(name: string) {
  return (_anchor: unknown, props: Record<string, unknown>) => {
    seen.props.push({ name, props });
  };
}
vi.mock("@still/core/ui/v3/DesktopPopup.svelte", () => ({ default: recorder("desktop") }));
vi.mock("@still/core/ui/v3/MobilePopup.svelte", () => ({ default: recorder("mobile") }));

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

async function popup(platform: "mac" | "ios") {
  const f = await installSafari({ saved: "atomic", platform });
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  document.body.innerHTML = '<div id="app"></div>';
  expect(await startSafariV3Popup({ env: ENV, platform: async () => platform })).toBe("v3");
  await waitFor(() => expect(seen.props.length).toBeGreaterThan(0));
  const last = seen.props.at(-1)!;
  return { f, close, name: last.name, props: last.props };
}

describe("Safari popup host: hand-off callbacks", () => {
  it("Mac: the desktop popup is a hand-off host; Get Still Pro and lock chips open still://pro through the app", async () => {
    const { f, close, name, props } = await popup("mac");
    expect(name).toBe("desktop");
    expect(props.appHandoff).toBe(true);
    // No purchase in Safari: Apple purchases happen only in the app (Guidelines 3.1.1, 3.1.3).
    expect(props.onPurchase).toBeUndefined();
    (props.onSeePro as () => void)();
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(f.native.filter((m) => m.kind === "openAppRoute")).toEqual([{ kind: "openAppRoute", route: "pro" }]);
    expect(f.createTab).not.toHaveBeenCalled();
  });

  it("Mac: Sign in opens still://sync through the app", async () => {
    const { f, close, props } = await popup("mac");
    (props.onSignIn as () => void)();
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(f.native.filter((m) => m.kind === "openAppRoute")).toEqual([{ kind: "openAppRoute", route: "sync" }]);
  });

  it("iPhone: the phone popup is a Safari hand-off host; actions open the fixed links in a Safari tab", async () => {
    const { f, close, name, props } = await popup("ios");
    expect(name).toBe("mobile");
    expect(props.host).toBe("safari");
    expect(props.appHandoff).toBe(true);
    expect(props.onPurchase).toBeUndefined();
    (props.onSeePro as () => void)();
    await waitFor(() => expect(f.createTab).toHaveBeenCalledTimes(1));
    (props.onSignIn as () => void)();
    await waitFor(() => expect(f.createTab).toHaveBeenCalledTimes(2));
    expect(f.createTab.mock.calls).toEqual([[{ url: "still://pro" }], [{ url: "still://sync" }]]);
    expect(close).toHaveBeenCalledTimes(2);
    expect(f.nativeKinds()).not.toContain("openAppRoute");
  });
});
