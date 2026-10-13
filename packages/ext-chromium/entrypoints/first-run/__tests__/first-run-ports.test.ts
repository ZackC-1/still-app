import { afterEach, describe, expect, it, vi } from "vitest";
import { firstRunAnalytics, firstRunPinApi, observePinned } from "../first-run-ports.js";

afterEach(() => {
  vi.useRealTimers();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pinned observer", () => {
  it("reports null where the browser cannot say (Firefox)", () => {
    const seen: Array<boolean | null> = [];
    observePinned(undefined, (p) => seen.push(p));
    expect(seen).toEqual([null]);
  });

  it("reports Chrome's own answer and follows its change event", async () => {
    let onToolbar = false;
    const listeners = new Set<() => void>();
    const api = {
      getUserSettings: vi.fn(async () => ({ isOnToolbar: onToolbar })),
      onUserSettingsChanged: {
        addListener: (l: () => void) => listeners.add(l),
        removeListener: (l: () => void) => listeners.delete(l),
      },
    };
    const seen: Array<boolean | null> = [];
    const stop = observePinned(api, (p) => seen.push(p));
    await flush();
    expect(seen).toEqual([false]);
    onToolbar = true;
    listeners.forEach((l) => l());
    await flush();
    expect(seen.at(-1)).toBe(true);
    stop();
    expect(listeners.size).toBe(0);
  });

  it("treats an unreadable answer as unknown, not unpinned", async () => {
    const seen: Array<boolean | null> = [];
    const stop = observePinned(
      { getUserSettings: () => Promise.reject(new Error("old Chrome")) },
      (p) => seen.push(p),
    );
    await flush();
    expect(seen).toEqual([null]);
    stop();
  });
});

describe("first-run analytics", () => {
  it("records no events but keeps the existing sharing switch and attribution", async () => {
    const page = {
      track: vi.fn(),
      identify: vi.fn(),
      reset: vi.fn(),
      sharing: vi.fn(async () => ({ enabled: true, noticeNeeded: true })),
      setSharing: vi.fn(async (enabled: boolean) => enabled),
      acknowledgeNotice: vi.fn(),
    };
    const analytics = firstRunAnalytics(page);
    analytics.track("opened", { where: "options" });
    expect(page.track).not.toHaveBeenCalled();
    analytics.identify("u1");
    expect(page.identify).toHaveBeenCalledWith("u1");
    expect(await analytics.sharing!()).toEqual({ enabled: true, noticeNeeded: true });
    expect(await analytics.setSharing!(false)).toBe(false);
    analytics.acknowledgeNotice!();
    expect(page.acknowledgeNotice).toHaveBeenCalledOnce();
  });
});

describe("firstRunPinApi (ISS-0031)", () => {
  const action = { getUserSettings: async () => ({ isOnToolbar: true }) };
  it("reads the pinned report on Chrome and on desktop Firefox", () => {
    expect(firstRunPinApi(false, "unknown", action)).toBe(action);
    expect(firstRunPinApi(true, "desktop", action)).toBe(action);
    // A Firefox whose platform answer never came is still a toolbar browser here.
    expect(firstRunPinApi(true, "unknown", action)).toBe(action);
  });
  it("never reads it on Firefox for Android, which has no toolbar", () => {
    expect(firstRunPinApi(true, "android", action)).toBeUndefined();
  });
});
