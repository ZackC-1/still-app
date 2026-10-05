import { afterEach, describe, expect, it, vi } from "vitest";
import {
  declaredSiteOrigins,
  firstRunAnalytics,
  observePinned,
  observeSiteAccess,
  type SiteAccessApi,
} from "../first-run-ports.js";
import { stillManifest } from "../../../wxt.config.js";

afterEach(() => {
  vi.useRealTimers();
});

const ORIGINS = ["*://*.youtube.com/*", "*://*.instagram.com/*"];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function permissions(granted: boolean) {
  const added = new Set<() => void>();
  const removed = new Set<() => void>();
  let answer: (granted: boolean) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const api = {
    granted,
    contains: vi.fn(async () => api.granted),
    request: vi.fn(
      () =>
        new Promise<boolean>((resolve, reject) => {
          answer = resolve;
          fail = reject;
        }),
    ),
    onAdded: { addListener: (l: () => void) => added.add(l), removeListener: (l: () => void) => added.delete(l) },
    onRemoved: { addListener: (l: () => void) => removed.add(l), removeListener: (l: () => void) => removed.delete(l) },
    answer: (value: boolean) => answer(value),
    fail: (error: unknown) => fail(error),
    fireAdded: () => [...added].forEach((l) => l()),
    listeners: () => added.size + removed.size,
  };
  return api;
}

describe("declared site origins", () => {
  it.each(["chrome", "firefox"])("asks for exactly the %s manifest's four hosts", (browser) => {
    const manifest = stillManifest(browser);
    expect(declaredSiteOrigins(manifest)).toEqual([
      "*://*.youtube.com/*",
      "*://*.instagram.com/*",
      "*://*.facebook.com/*",
      "*://*.tiktok.com/*",
    ]);
  });
});

describe("site access observer", () => {
  it("reports granted only from the browser's answer", async () => {
    const api = permissions(true);
    const seen: string[] = [];
    observeSiteAccess(api, ORIGINS, (s) => seen.push(s));
    await flush();
    expect(seen).toEqual(["granted"]);
    expect(api.contains).toHaveBeenCalledWith({ origins: ORIGINS });
  });

  it("asks inside the tap, shows pending, then the browser's grant", async () => {
    const api = permissions(false);
    const seen: string[] = [];
    const access = observeSiteAccess(api, ORIGINS, (s) => seen.push(s));
    await flush();
    expect(seen).toEqual(["needed"]);
    access.request!();
    // Synchronous: no await may separate the tap from the browser's prompt.
    expect(api.request).toHaveBeenCalledWith({ origins: ORIGINS });
    expect(seen.at(-1)).toBe("pending");
    api.granted = true;
    api.answer(true);
    await flush();
    expect(seen.at(-1)).toBe("granted");
  });

  it("reports denied only when the browser answers no, and lets the person try again", async () => {
    const api = permissions(false);
    const seen: string[] = [];
    const access = observeSiteAccess(api, ORIGINS, (s) => seen.push(s));
    await flush();
    access.request!();
    api.answer(false);
    await flush();
    expect(seen.at(-1)).toBe("denied");
    access.request!();
    expect(api.request).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toBe("pending");
  });

  it("does not call a failed request a denial", async () => {
    const api = permissions(false);
    const seen: string[] = [];
    const access = observeSiteAccess(api, ORIGINS, (s) => seen.push(s));
    await flush();
    access.request!();
    api.fail(new Error("no user gesture"));
    await flush();
    expect(seen.at(-1)).toBe("needed");
  });

  it("follows a grant made elsewhere (browser menu) after a denial", async () => {
    const api = permissions(false);
    const seen: string[] = [];
    const access = observeSiteAccess(api, ORIGINS, (s) => seen.push(s));
    await flush();
    access.request!();
    api.answer(false);
    await flush();
    api.granted = true;
    api.fireAdded();
    await flush();
    expect(seen.at(-1)).toBe("granted");
  });

  it("ignores a second tap while a request is open, and requests nothing once granted", async () => {
    const api = permissions(false);
    const access = observeSiteAccess(api, ORIGINS, () => {});
    await flush();
    access.request!();
    access.request!();
    expect(api.request).toHaveBeenCalledOnce();
    api.granted = true;
    api.answer(true);
    await flush();
    access.request!();
    expect(api.request).toHaveBeenCalledOnce();
  });

  it("stays unknown when the browser cannot answer, and offers no request without the API", async () => {
    const seen: string[] = [];
    const broken: SiteAccessApi = { contains: () => Promise.reject(new Error("unavailable")) };
    const access = observeSiteAccess(broken, ORIGINS, (s) => seen.push(s));
    await flush();
    expect(seen).toEqual(["unknown"]);
    expect(access.request).toBeUndefined();
  });

  it("stops listening when the page goes", async () => {
    const api = permissions(true);
    const access = observeSiteAccess(api, ORIGINS, () => {});
    expect(api.listeners()).toBe(2);
    access.stop();
    expect(api.listeners()).toBe(0);
  });
});

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
