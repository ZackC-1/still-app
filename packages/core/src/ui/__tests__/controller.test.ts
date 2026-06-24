import { describe, it, expect, vi } from "vitest";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { UiController, type UiAuth, type UiHost } from "../controller.svelte.js";

function makeController(extra: { host?: Partial<UiHost>; auth?: UiAuth } = {}) {
  const cache = new SettingsCache(new InMemoryStorageAdapter(null), { now: () => Date.now() });
  const c = new UiController({
    cache,
    host: { canPurchase: true, currentHost: "youtube.com", ...extra.host },
    auth: extra.auth,
  });
  return { c, cache };
}

describe("UiController", () => {
  it("toggles a service through the cache", () => {
    const { c, cache } = makeController();
    const spy = vi.spyOn(cache, "setService");
    c.toggleService("youtube");
    expect(spy).toHaveBeenCalledWith("youtube", false); // default on → off
  });

  it("toggles the global switch through the cache", () => {
    const { c, cache } = makeController();
    const spy = vi.spyOn(cache, "setGlobalOn");
    c.toggleGlobal();
    expect(spy).toHaveBeenCalledWith(false);
  });

  it("pauses then resumes the current host", () => {
    const { c, cache } = makeController();
    const pause = vi.spyOn(cache, "pauseHost");
    c.togglePause();
    expect(pause).toHaveBeenCalledWith("youtube.com");
  });

  it("derives the full popup state matrix", () => {
    const { c } = makeController();
    expect(c.popupState).toBe("signed-out");
    c.userId = "u";
    c.reconciling = true;
    expect(c.popupState).toBe("entitlement-pending");
    c.reconciling = false;
    expect(c.popupState).toBe("not-entitled");
    c.entitled = true;
    expect(c.popupState).toBe("entitled-syncing");
    c.cloudReachable = false;
    expect(c.popupState).toBe("cloud-unreachable");
  });

  it("runs the magic-link flow idle → sending → sent", async () => {
    const signIn = vi.fn(() => Promise.resolve({}));
    const { c } = makeController({ auth: { signIn, signOut: vi.fn(() => Promise.resolve()) } });
    const pending = c.signIn("a@b.com");
    expect(c.authFlow).toBe("sending");
    await pending;
    expect(c.authFlow).toBe("sent");
    expect(signIn).toHaveBeenCalledWith("a@b.com");
  });

  it("surfaces an auth error", async () => {
    const { c } = makeController({
      auth: { signIn: () => Promise.resolve({ error: "rate limited" }), signOut: vi.fn(() => Promise.resolve()) },
    });
    await c.signIn("a@b.com");
    expect(c.authFlow).toBe("error");
    expect(c.authError).toBe("rate limited");
  });
});
