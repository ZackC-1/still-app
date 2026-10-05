import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsCache } from "@still/core/storage";
import { EntitlementCache } from "@still/core/entitlement";
import { composeSafariV3 } from "../../../lib/safari-v3-runtime.js";
import { installSafari } from "./safari-native.fixture.js";

// composeSafariV3 starts several watchers one after another. If a later step throws, the earlier
// ones must be stopped, because the caller never receives a composition to stop.
const gate = vi.hoisted(() => ({ failBinding: false }));
vi.mock("../../../../core/src/ui/v3/desktop-popup-binding.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../../core/src/ui/v3/desktop-popup-binding.js")>();
  return {
    ...real,
    createDesktopPopupBinding: (...args: Parameters<typeof real.createDesktopPopupBinding>) => {
      if (gate.failBinding) throw new Error("binding failed");
      return real.createDesktopPopupBinding(...args);
    },
  };
});

afterEach(() => {
  gate.failBinding = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Records when each watcher's stop function is called. */
function trackStops() {
  const stops = { settings: vi.fn(), entitlement: vi.fn() };
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
  return stops;
}

describe("composeSafariV3: a failure partway through", () => {
  it("stops the settings watch, the entitlement watch and account polling it already started", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = await installSafari({ saved: "atomic", signedIn: true });
    const stops = trackStops();
    gate.failBinding = true;

    expect(() => composeSafariV3("popup")).toThrow("binding failed");

    expect(stops.settings).toHaveBeenCalledOnce();
    expect(stops.entitlement).toHaveBeenCalledOnce();
    expect(f.storageListenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0); // account polling's interval is gone
  });

  it("a composition that succeeds keeps them running until it is stopped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = await installSafari({ saved: "atomic", signedIn: true });
    const stops = trackStops();

    const composition = composeSafariV3("popup");
    expect(stops.settings).not.toHaveBeenCalled();
    expect(f.storageListenerCount()).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    composition.stop();
    expect(stops.settings).toHaveBeenCalledOnce();
    expect(stops.entitlement).toHaveBeenCalledOnce();
    expect(f.storageListenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
