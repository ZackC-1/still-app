import { describe, it, expect, vi } from "vitest";
import type { StillBridgeWindow } from "../../storage/wkwebview-adapter.js";
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
    expect((await bridge.purchaseStillSync()).outcome).toBe("failed");
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
    expect(await new NativeBridge(ok.win).purchaseStillSync()).toEqual({
      outcome: "purchased",
      entitled: true,
      error: undefined,
    });

    const cancelled = makeHost({ purchase: { outcome: "cancelled", entitled: false } });
    expect((await new NativeBridge(cancelled.win).purchaseStillSync()).outcome).toBe("cancelled");

    const unavailable = makeHost({ purchase: { outcome: "unavailable", entitled: false } });
    expect((await new NativeBridge(unavailable.win).purchaseStillSync()).outcome).toBe("unavailable");

    const bad = makeHost({ purchase: { outcome: "nonsense", entitled: false } });
    expect((await new NativeBridge(bad.win).purchaseStillSync()).outcome).toBe("failed");
  });

  it("reads restore + status entitlement", async () => {
    const host = makeHost({ restore: { entitled: true }, purchaseStatus: { entitled: false } });
    const bridge = new NativeBridge(host.win);
    expect(await bridge.restore()).toBe(true);
    expect(await bridge.purchaseStatus()).toBe(false);
  });

  it("reads the localized store price, or null when unavailable", async () => {
    expect(await new NativeBridge(makeHost({ price: { price: "$1.99" } }).win).price()).toBe("$1.99");
    // Empty / missing price → null (offering not loaded), so the CTA shows no price rather than a guess.
    expect(await new NativeBridge(makeHost({ price: {} }).win).price()).toBeNull();
    expect(await new NativeBridge(makeHost({ price: { price: "" } }).win).price()).toBeNull();
  });
});
