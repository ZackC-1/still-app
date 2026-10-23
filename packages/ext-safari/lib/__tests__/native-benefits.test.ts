import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChromeEntitlementAdapter,
  DESKTOP_LAYOUT_ONLY_PRO,
  EntitlementCache,
  accessCapabilities,
  initialAccessSnapshot,
  packagedAccessContext,
  type AccessPlatform,
} from "@still/core/entitlement";
import { FEATURE_REGISTRY, type BenefitId } from "@still/shared-types";
import { parseNativeBenefitReply } from "../native-benefits.js";
import { appManagedPopupAccount, appManagedSettingsSync } from "../safari-v3.js";
import { stillProTag } from "../../../core/src/ui/v3/presentation.js";

// A purchased snapshot as the native handler commits it (shape only; values are synthetic).
const base = initialAccessSnapshot(packagedAccessContext("safari", "desktop"));
const snapshot = { ...base, states: { ...base.states, "youtube.comments": "purchased" } };
const lane = (body: unknown) => ({ entitlement: JSON.stringify(body) });

describe("parseNativeBenefitReply", () => {
  it("reads the snapshot from the handler's entitlement lane", () => {
    const parsed = parseNativeBenefitReply(lane({ ok: true, snapshot }));
    expect(parsed.states["youtube.comments"]).toBe("purchased");
    expect(parsed.generation).toBe(snapshot.generation);
  });

  it("fails closed on the settings lane, ok:false, malformed JSON and a bad snapshot", () => {
    for (const reply of [
      { settings: JSON.stringify({ ok: true, snapshot }) },
      lane({ ok: false }),
      lane({ ok: true, snapshot: { ...snapshot, states: {} } }),
      { entitlement: "{" },
      { entitlement: { ok: true, snapshot } },
      null,
      "",
    ]) expect(() => parseNativeBenefitReply(reply)).toThrow();
  });

  it("matches the lane the Safari handler actually replies on", () => {
    const handler = readFileSync(new URL("../../../../apps/apple/Still/Shared (Extension)/SafariWebExtensionHandler.swift", import.meta.url), "utf8");
    expect(handler).toContain('payload = ["entitlement": entitlementJSON]');
    expect(handler).toContain("EntitlementBridge.safariExtension(store: .appGroup())");
  });

  it("is reached from the background only inside the folded paid branch", () => {
    const background = readFileSync(new URL("../../entrypoints/background.ts", import.meta.url), "utf8");
    expect(background).toContain("if (PAID_TIER_ENABLED) return parseNativeBenefitReply(reply);");
    expect(background.match(/parseNativeBenefitReply/g)).toHaveLength(2); // the import and the folded call
  });
});

// ISS-0030 pass-through guard: the adapter and cache the Safari background wires (background.ts)
// must not rewrite the app's native answer. The extension's own context is signed out with
// unknown evidence; the native snapshot is the authority, so its "locked" rows must reach the
// popup as locked, and a later "purchased" must replace them on the next read. The bug itself was
// in the native answer and is covered by StillKit's SafariAccessLaneTests.
describe("Safari popup cache passes the native benefit answer through unchanged", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const proRows = FEATURE_REGISTRY.filter(feature => feature.tier !== "free").map(feature => feature.id as BenefitId);
  function nativeReply(platform: AccessPlatform, proState: "locked" | "verification_required" | "purchased") {
    const supported = accessCapabilities({ paidMode: true, host: "safari", platform });
    const base = initialAccessSnapshot({ paidMode: true, supported });
    const states = Object.fromEntries(Object.entries(base.states).map(([benefit, state]) =>
      [benefit, state === "checking" ? proState : state])); // the seed's supported paid extras
    return lane({ ok: true, snapshot: { ...base, states } });
  }
  function safariCache(platform: AccessPlatform, reply: () => unknown) {
    vi.stubGlobal("chrome", { storage: { local: {} } });
    const supported = accessCapabilities({ paidMode: true, host: "safari", platform });
    const adapter = new ChromeEntitlementAdapter(Date.now, {
      authority: true,
      // Signed out with nothing of its own: the shape packagedAccessContext gives every Safari read.
      context: () => ({ paidMode: true, supported, localRights: new Set(), evidenceStatus: "unknown" }),
      nativeObservation: async () => parseNativeBenefitReply(reply()),
    });
    return { adapter, cache: new EntitlementCache(adapter, { access: { paidMode: true, supported } }) };
  }

  for (const [platform, count] of [["desktop", 12], ["ios", 9]] as const) {
    it(`shows every supported Still Pro row locked on ${platform} when the app says no purchase`, async () => {
      const { cache } = safariCache(platform, () => nativeReply(platform, "locked"));
      await cache.refreshAccess();
      const supportedPro = proRows.filter(id => platform === "desktop" || !(DESKTOP_LAYOUT_ONLY_PRO as readonly string[]).includes(id));
      expect(supportedPro).toHaveLength(count);
      for (const id of supportedPro) expect(cache.currentAccess(id)).toBe("locked");
      if (platform === "ios") for (const id of DESKTOP_LAYOUT_ONLY_PRO) expect(cache.currentAccess(id)).toBe("unsupported");
      expect(cache.currentAccess("youtube.shorts")).toBe("free");
    });
  }

  it("keeps an inconclusive native answer as verification required, and a later purchase unlocks", async () => {
    let reply = nativeReply("desktop", "verification_required");
    const { adapter, cache } = safariCache("desktop", () => reply);
    await cache.refreshAccess();
    expect(cache.currentAccess("youtube.comments")).toBe("verification_required");
    reply = nativeReply("desktop", "locked");
    adapter.invalidateAccessContext();
    await cache.refreshAccess();
    expect(cache.currentAccess("youtube.comments")).toBe("locked");
    reply = nativeReply("desktop", "purchased");
    adapter.invalidateAccessContext();
    await cache.refreshAccess();
    for (const id of proRows) expect(cache.currentAccess(id)).toBe("purchased");
  });

  it("never turns a failed native read into locked", async () => {
    const { cache } = safariCache("desktop", () => ({ entitlement: JSON.stringify({ ok: false }) }));
    expect(cache.currentAccess("youtube.comments")).toBe("checking"); // nothing asked yet
    await expect(cache.refreshAccess()).resolves.toBeDefined();
    expect(cache.currentAccess("youtube.comments")).toBe("verification_required");
    expect(cache.currentAccess("youtube.shorts")).toBe("free");
  });
});

// ISS-0105 follow-up: the background keeps native's snapshot for up to refreshAfterMs, and nothing
// on Safari invalidates it when the app changes account, while the popup reads the account line
// fresh. The snapshot therefore names the account its "Still Pro User" answer is about, and the
// popup shows that tag only beside that account.
describe("a kept snapshot never puts one account's Still Pro User tag beside another account", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const TEXT = { unreachable: "u", syncing: "s", synced: "y", checking: "c" };
  const signedIn = (userId: string) => ({ userId, accountEmail: `${userId.slice(0, 1)}@example.invalid`, cloudReachable: true,
    pendingUpload: false, lastSyncedAt: 1, accountRevision: 1 });

  it("A holds Still Pro, the app switches to B within refreshAfterMs: the popup says Still Pro on this device", async () => {
    vi.stubGlobal("chrome", { storage: { local: {} } });
    const supported = accessCapabilities({ paidMode: true, host: "safari", platform: "desktop" });
    const seed = initialAccessSnapshot({ paidMode: true, supported });
    const states = Object.fromEntries(Object.entries(seed.states).map(([benefit, state]) => [benefit, state === "checking" ? "purchased" : state]));
    // What native answers while A is signed in, then after the app switched to B (this device's purchase).
    let reply = lane({ ok: true, snapshot: { ...seed, states, accountHoldsPro: true, accountHoldsProFor: A } });
    const nativeObservation = vi.fn(async () => parseNativeBenefitReply(reply));
    // Wired as entrypoints/background.ts wires it: the authority adapter over the native answer.
    const background = new ChromeEntitlementAdapter(Date.now, {
      authority: true,
      context: () => ({ paidMode: true, supported, localRights: new Set(), evidenceStatus: "unknown" }),
      nativeObservation,
    });

    // The popup opens while A is signed in.
    const first = new EntitlementCache(background, { access: { paidMode: true, supported } });
    await first.refreshAccess();
    const before = first.currentAccessSnapshot();
    const accountA = appManagedPopupAccount(signedIn(A), TEXT, before);
    expect(accountA?.holdsPro).toBe(true);
    expect(stillProTag(before, accountA)).toBe("account");

    // In the app: sign out, sign in as B (who holds no Still Pro). The popup reopens at once.
    reply = lane({ ok: true, snapshot: { ...seed, states, accountHoldsPro: false, accountHoldsProFor: null } });
    const second = new EntitlementCache(background, { access: { paidMode: true, supported } });
    await second.refreshAccess();
    const kept = second.currentAccessSnapshot();
    // The background served its kept snapshot (still A's answer), not a fresh native read...
    expect(nativeObservation).toHaveBeenCalledOnce();
    expect(kept.accountHoldsProFor).toBe(A);
    // ...and B's line still reads "Still Pro on this device".
    const accountB = appManagedPopupAccount(signedIn(B), TEXT, kept);
    expect(accountB?.holdsPro).toBe(false);
    expect(stillProTag(kept, accountB)).toBe("device");
    expect(stillProTag(kept, appManagedSettingsSync(signedIn(B), TEXT, undefined, kept).account)).toBe("device");
  });
});
