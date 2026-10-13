import { describe, expect, it, vi } from "vitest";
import { declaredSiteOrigins, observeSiteAccess, type SiteAccessApi } from "../site-access.js";
import { stillManifest } from "../../wxt.config.js";

// The site access observer shared by the first-run page's "Allow Still on supported sites" step
// and the popup and settings warning (ISS-0037).

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
    fireRemoved: () => [...removed].forEach((l) => l()),
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

  it("follows a removal made in the browser's own settings while the page is open (ISS-0037)", async () => {
    const api = permissions(true);
    const seen: string[] = [];
    observeSiteAccess(api, ORIGINS, (s) => seen.push(s));
    await flush();
    expect(seen).toEqual(["granted"]);
    api.granted = false;
    api.fireRemoved();
    await flush();
    expect(seen.at(-1)).toBe("needed");
  });

  it("asks nothing and stays unknown when the manifest declares no hosts", async () => {
    expect(declaredSiteOrigins({})).toEqual([]);
    expect(declaredSiteOrigins({ host_permissions: "*://*.youtube.com/*" })).toEqual([]);
    expect(declaredSiteOrigins({ host_permissions: ["*://*.youtube.com/*", 7] })).toEqual([
      "*://*.youtube.com/*",
    ]);
    const api = permissions(false);
    const seen: string[] = [];
    observeSiteAccess(api, [], (s) => seen.push(s));
    await flush();
    expect(seen).toEqual(["unknown"]);
    expect(api.contains).not.toHaveBeenCalled();
  });

  it("keeps only the newest answer when two reads overlap", async () => {
    const answers: Array<(granted: boolean) => void> = [];
    const api: SiteAccessApi = {
      contains: () => new Promise<boolean>((resolve) => answers.push(resolve)),
    };
    const seen: string[] = [];
    const access = observeSiteAccess(api, ORIGINS, (s) => seen.push(s));
    void access.refresh();
    answers[1]!(true);
    await flush();
    answers[0]!(false);
    await flush();
    expect(seen).toEqual(["granted"]);
  });

  it("holds pending through a removal during the prompt, then takes the browser's answer", async () => {
    const api = permissions(false);
    const seen: string[] = [];
    const access = observeSiteAccess(api, ORIGINS, (s) => seen.push(s));
    await flush();
    access.request!();
    api.fireRemoved();
    await flush();
    expect(seen.at(-1)).toBe("pending");
    api.answer(false);
    await flush();
    expect(seen.at(-1)).toBe("denied");
  });

  it("takes a grant seen while a request's promise never settles (a popup closed under the prompt)", async () => {
    const api = permissions(false);
    const seen: string[] = [];
    const access = observeSiteAccess(api, ORIGINS, (s) => seen.push(s));
    await flush();
    access.request!();
    expect(seen.at(-1)).toBe("pending");
    api.granted = true;
    api.fireAdded();
    await flush();
    expect(seen.at(-1)).toBe("granted");
  });

  it("publishes nothing after it stops, even when the browser answers later", async () => {
    const api = permissions(false);
    const seen: string[] = [];
    const access = observeSiteAccess(api, ORIGINS, (s) => seen.push(s));
    await flush();
    access.request!();
    const before = seen.length;
    access.stop();
    api.granted = true;
    api.answer(true);
    await flush();
    expect(seen.length).toBe(before);
  });

  it("stops listening when the page goes", async () => {
    const api = permissions(true);
    const access = observeSiteAccess(api, ORIGINS, () => {});
    expect(api.listeners()).toBe(2);
    access.stop();
    expect(api.listeners()).toBe(0);
  });
});
