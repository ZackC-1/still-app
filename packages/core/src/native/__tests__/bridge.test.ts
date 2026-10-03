import { describe, it, expect, vi } from "vitest";
import type { StillBridgeWindow } from "../../storage/wkwebview-adapter.js";
import { ACCESS_OBSERVATION_DEADLINE_MS, initialAccessSnapshot } from "../../entitlement/access-policy.js";
import { NativeBridge } from "../bridge.js";

/** A fake native host: a postMessage port (WKScriptMessageHandlerWithReply) returning canned JSON
 * objects per `kind`, mirroring WebBridgeRouter.swift. */
function makeHost(replies: Record<string, unknown>) {
  const posted: Array<{ kind: string } & Record<string, unknown>> = [];
  const port = {
    postMessage: vi.fn(async (msg: unknown): Promise<unknown> => {
      const m = msg as { kind: string } & Record<string, unknown>;
      posted.push(m);
      return replies[m.kind];
    }),
  };
  const win: StillBridgeWindow = { webkit: { messageHandlers: { still: port } } };
  return { win, port, posted };
}

describe("NativeBridge", () => {
  it("is unavailable with no native host (plain browser)", async () => {
    const bridge = new NativeBridge({} as StillBridgeWindow);
    expect(bridge.available).toBe(false);
    await expect(bridge.signInWithApple()).rejects.toThrow();
    expect(await bridge.restore()).toBe(false);
    expect(await bridge.purchaseStatus()).toBe(false);
    expect((await bridge.purchaseStillPro()).outcome).toBe("failed");
    await expect(bridge.signOut()).resolves.toBeUndefined(); // no-op without a host, never throws
  });

  it("posts signOut to reset the native RevenueCat identity", async () => {
    const host = makeHost({ signOut: { ok: true } });
    await new NativeBridge(host.win).signOut();
    expect(host.posted).toContainEqual({ kind: "signOut" });
  });

  it("is available inside the WKWebView host", () => {
    const { win } = makeHost({});
    expect(new NativeBridge(win).available).toBe(true);
  });

  it("returns the Apple credential and accepts both object and JSON-string replies", async () => {
    const cred = { identityToken: "tok", nonce: "n123", email: "a@b.co", fullName: "A B" };
    const objHost = makeHost({ signInWithApple: cred });
    expect(await new NativeBridge(objHost.win).signInWithApple()).toEqual(cred);

    const strHost = makeHost({ signInWithApple: JSON.stringify(cred) });
    expect(await new NativeBridge(strHost.win).signInWithApple()).toEqual(cred);
  });

  it("throws the native error when sign-in fails or is cancelled", async () => {
    const { win } = makeHost({ signInWithApple: { error: "Sign in was cancelled." } });
    await expect(new NativeBridge(win).signInWithApple()).rejects.toThrow("Sign in was cancelled.");
  });

  it("posts the Supabase UUID to configurePurchases (KTD5)", async () => {
    const host = makeHost({ configurePurchases: { ok: true } });
    await new NativeBridge(host.win).configurePurchases("uuid-123");
    expect(host.posted).toContainEqual({ kind: "configurePurchases", appUserID: "uuid-123" });
  });

  it("maps purchase outcomes and entitlement", async () => {
    const ok = makeHost({ purchase: { outcome: "purchased", entitled: true } });
    expect(await new NativeBridge(ok.win).purchaseStillPro()).toEqual({
      outcome: "purchased",
      entitled: true,
      error: undefined,
    });

    const cancelled = makeHost({ purchase: { outcome: "cancelled", entitled: false } });
    expect((await new NativeBridge(cancelled.win).purchaseStillPro()).outcome).toBe("cancelled");

    const unavailable = makeHost({ purchase: { outcome: "unavailable", entitled: false } });
    expect((await new NativeBridge(unavailable.win).purchaseStillPro()).outcome).toBe("unavailable");

    const bad = makeHost({ purchase: { outcome: "nonsense", entitled: false } });
    expect((await new NativeBridge(bad.win).purchaseStillPro()).outcome).toBe("failed");
  });

  it("reads restore + status entitlement", async () => {
    const host = makeHost({ restore: { entitled: true }, purchaseStatus: { entitled: false } });
    const bridge = new NativeBridge(host.win);
    expect(await bridge.restore()).toBe(true);
    expect(await bridge.purchaseStatus()).toBe(false);
  });

  it("parses the receipt tri-state, coercing malformed replies to noSignal (never a downgrade signal)", async () => {
    expect(
      await new NativeBridge(makeHost({ receiptStatus: { receipt: "entitled" } }).win).receiptStatus(),
    ).toBe("entitled");
    expect(
      await new NativeBridge(
        makeHost({ receiptStatus: { receipt: "verifiedNotEntitled" } }).win,
      ).receiptStatus(),
    ).toBe("verifiedNotEntitled");
    // Malformed / missing / unknown replies are ambiguity, not a verdict (tri-state contract).
    expect(
      await new NativeBridge(makeHost({ receiptStatus: {} }).win).receiptStatus(),
    ).toBe("noSignal");
    expect(
      await new NativeBridge(makeHost({ receiptStatus: { receipt: "banana" } }).win).receiptStatus(),
    ).toBe("noSignal");
    expect(await new NativeBridge({} as StillBridgeWindow).receiptStatus()).toBe("noSignal");
  });

  it("parses attachPurchases, coercing malformed replies to false", async () => {
    expect(
      await new NativeBridge(makeHost({ attachPurchases: { entitled: true } }).win).attachPurchases(),
    ).toBe(true);
    expect(
      await new NativeBridge(makeHost({ attachPurchases: {} }).win).attachPurchases(),
    ).toBe(false);
    expect(await new NativeBridge({} as StillBridgeWindow).attachPurchases()).toBe(false);
  });

  it("maps a native staleIdentity purchase reply through the outcome union (R15)", async () => {
    const host = makeHost({ purchase: { outcome: "staleIdentity", entitled: false } });
    expect((await new NativeBridge(host.win).purchaseStillPro()).outcome).toBe("staleIdentity");
  });

  it("reads the localized store price, or null when unavailable", async () => {
    expect(await new NativeBridge(makeHost({ price: { price: "$1.99" } }).win).price()).toBe("$1.99");
    // Empty / missing price → null (offering not loaded), so the CTA shows no price rather than a guess.
    expect(await new NativeBridge(makeHost({ price: {} }).win).price()).toBeNull();
    expect(await new NativeBridge(makeHost({ price: { price: "" } }).win).price()).toBeNull();
  });
  it("reads the closed native benefit projection without sending trust/context/clock input", async () => {
    const snapshot = initialAccessSnapshot();
    const host = makeHost({ getBenefitAccess: JSON.stringify({ ok: true, snapshot }) });
    expect(await new NativeBridge(host.win).observeBenefits()).toEqual(snapshot);
    expect(host.posted).toEqual([{ kind: "getBenefitAccess" }]);
    await expect(new NativeBridge(makeHost({ getBenefitAccess: { ok: true, record: {} } }).win).observeBenefits()).rejects.toThrow();
    await expect(new NativeBridge({}).observeBenefits()).rejects.toThrow();
  });

  it("bounds a hung native projection read and permits retry after the host recovers", async () => {
    vi.useFakeTimers();
    try {
      const host = makeHost({ getBenefitAccess: { ok: true, snapshot: initialAccessSnapshot() } });
      host.port.postMessage.mockImplementationOnce(() => new Promise(() => undefined));
      const bridge = new NativeBridge(host.win);
      const pending = bridge.observeBenefits(); const rejected = expect(pending).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(ACCESS_OBSERVATION_DEADLINE_MS); await rejected;
      expect(vi.getTimerCount()).toBe(0);
      expect(await bridge.observeBenefits()).toEqual(initialAccessSnapshot());
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

});
