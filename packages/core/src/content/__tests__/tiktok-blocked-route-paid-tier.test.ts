import { describe, expect, it, vi } from "vitest";

// ISS-0036, background half: with the paid tier compiled on, the TikTok route reads committed
// settings with `pro: false` for a person without Still Pro. It must still answer "redirected" and
// send the tab to the extension's blocked page, not "held" (which leaves only the in-page block).
vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

const { DEFAULT_SETTINGS, PAID_TIER_ENABLED } = await import("@still/shared-types");
const { createTiktokBlockedRoute, TIKTOK_ROUTE } = await import("../tiktok-blocked-route.js");
const seed = (await import("../../../rules/seed.json")).default;
type SignedRuleSet = import("@still/shared-types").SignedRuleSet;
type TiktokRouteReply = import("../tiktok-blocked-route.js").TiktokRouteReply;

const ORIGIN = "chrome-extension://still/";
const PAGE = `${ORIGIN}tiktok-blocked.html`;

function route(tiktok: boolean) {
  const url = "https://www.tiktok.com/foryou";
  const session = new Map<string, unknown>();
  const update = vi.fn(async () => ({}));
  const listeners = { addListener: () => {}, removeListener: () => {} };
  const created = createTiktokBlockedRoute({
    runtimeId: "still",
    extensionOrigin: ORIGIN,
    pageUrl: PAGE,
    session: {
      get: async (key) => (session.has(key) ? { [key]: session.get(key) } : {}),
      set: async (items) => {
        for (const [key, value] of Object.entries(items)) session.set(key, value);
      },
      remove: async (key) => void session.delete(key),
    },
    tabs: { get: async (id) => ({ id, url }), update, onRemoved: listeners, onReplaced: listeners },
    ruleSet: seed as unknown as SignedRuleSet,
    // Exactly what both backgrounds hand the route for a signed-out person without Still Pro.
    readCommitted: async () => ({
      settings: { ...DEFAULT_SETTINGS, services: { ...DEFAULT_SETTINGS.services, tiktok } },
      options: { pro: false },
    }),
    canVerifyDocuments: true,
    randomId: () => "request-0001-fixture",
    createAuthority: () => ({
      supported: true,
      allow: async () => false,
      isAllowed: async () => false,
      stop: async () => {},
    }),
  });
  const ask = () =>
    new Promise<TiktokRouteReply>((resolve) => {
      created.listener({ kind: TIKTOK_ROUTE.blocked }, { id: "still", url, frameId: 0, tab: { id: 7 } }, resolve);
    });
  return { ask, update };
}

describe("TikTok route with the paid tier compiled on (ISS-0036)", () => {
  it("runs with the paid tier on", () => {
    expect(PAID_TIER_ENABLED).toBe(true);
  });

  it("sends a blocked TikTok tab to the extension page without Still Pro", async () => {
    const { ask, update } = route(true);
    await expect(ask()).resolves.toEqual({ status: "redirected" });
    expect(update).toHaveBeenCalledWith(7, { url: `${PAGE}?r=request-0001-fixture` });
  });

  it("leaves TikTok alone when TikTok Blocker is Off", async () => {
    const { ask, update } = route(false);
    await expect(ask()).resolves.toEqual({ status: "held" });
    expect(update).not.toHaveBeenCalled();
  });
});
