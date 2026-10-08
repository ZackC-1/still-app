import { describe, expect, it, vi } from "vitest";
import {
  NativeBridge,
  NATIVE_PURCHASE_DEADLINE_MS,
  type NativeLifetimeOffering,
} from "../bridge.js";
import type { StillBridgeWindow } from "../../storage/wkwebview-adapter.js";

const offer: NativeLifetimeOffering = {
  productId: "still_pro_v3",
  offeringId: "still_pro_v3",
  packageId: "$rc_lifetime",
  package: "still-pro-v3",
  kind: "lifetime",
  price: "9,99 €",
  currencyCode: "EUR",
};
function host(
  reply: (message: { kind: string; offer?: unknown }) => Promise<unknown>,
) {
  const post = vi.fn(reply);
  const bridge = new NativeBridge({
    webkit: { messageHandlers: { still: { postMessage: post } } },
  } as StillBridgeWindow);
  return { bridge, post };
}

describe("native scoped Pro feedback", () => {
  it("preserves the exact localized lifetime tuple and posts that displayed offer", async () => {
    const { bridge, post } = host(async (message) =>
      message.kind === "proOffering"
        ? { offer }
        : {
            outcome: "purchased",
            receipt: "entitled",
            productId: "still_pro_v3",
          },
    );
    expect(await bridge.proOffering()).toEqual(offer);
    expect(await bridge.purchasePro(offer)).toEqual({
      outcome: "purchased",
      receipt: "entitled",
      productId: "still_pro_v3",
    });
    expect(post).toHaveBeenLastCalledWith({ kind: "purchasePro", offer });
  });

  it.each([
    { ...offer, offeringId: "default" },
    { ...offer, packageId: "$rc_annual" },
    { ...offer, productId: "still_sync" },
    { ...offer, kind: "subscription" },
    { ...offer, price: " " },
    { ...offer, currencyCode: "eur" },
    { ...offer, entitled: true },
  ])("rejects unavailable or arbitrary offer metadata %j", async (invalid) => {
    const { bridge, post } = host(async () => ({ offer: invalid }));
    expect(await bridge.proOffering()).toBeNull();
    expect(
      await bridge.purchasePro(invalid as NativeLifetimeOffering),
    ).toMatchObject({ outcome: "unavailable" });
    expect(post).toHaveBeenCalledOnce();
  });

  it.each([
    { outcome: "purchased", receipt: "noSignal" },
    { outcome: "purchased", receipt: "entitled", productId: "still_sync" },
    {
      outcome: "restored",
      receipt: "verifiedNotEntitled",
      productId: "still_sync",
    },
  ])("never promotes unverified feedback to success %j", async (reply) => {
    const { bridge } = host(async () => reply);
    expect((await bridge.purchasePro(offer)).outcome).toBe("pending");
  });

  it.each([
    "cancelled",
    "pending",
    "unavailable",
    "staleIdentity",
    "failed",
    "nothing",
  ] as const)("preserves the conclusive native outcome %s", async (outcome) => {
    const { bridge } = host(async () => ({ outcome, receipt: "noSignal" }));
    expect(await bridge.restorePro()).toEqual({ outcome, receipt: "noSignal" });
  });

  it("restores a verified historical product without calling account attachment", async () => {
    const { bridge, post } = host(async () => ({
      outcome: "restored",
      receipt: "entitled",
      productId: "still_sync",
    }));
    expect((await bridge.restorePro()).outcome).toBe("restored");
    expect(post).toHaveBeenCalledExactlyOnceWith({ kind: "restorePro" });
  });

  it("rejects contradictory nothing-to-restore and fabricated boolean grants", async () => {
    for (const reply of [
      { outcome: "nothing", receipt: "entitled", productId: "still_pro_v3" },
      {
        outcome: "purchased",
        receipt: "entitled",
        productId: "still_pro_v3",
        entitled: true,
      },
    ]) {
      expect((await host(async () => reply).bridge.restorePro()).outcome).toBe(
        "failed",
      );
    }
  });

  it("bounds a silent purchase as pending and a silent restore as failed, never nothing", async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = host(() => new Promise(() => {}));
      const buy = bridge.purchasePro(offer),
        restore = bridge.restorePro();
      await vi.advanceTimersByTimeAsync(NATIVE_PURCHASE_DEADLINE_MS);
      expect(await buy).toEqual({ outcome: "pending", receipt: "noSignal" });
      expect(await restore).toEqual({ outcome: "failed", receipt: "noSignal" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("only transports bounded functional JWS evidence without caller identity or access flags", async () => {
    const evidence = {
      productId: "still_pro_v3",
      bundleId: "org.example.Still",
      signedTransaction: "header.payload.signature",
    };
    const { bridge, post } = host(async () => ({ evidence }));
    expect(await bridge.applePurchaseEvidence()).toEqual(evidence);
    expect(post).toHaveBeenCalledExactlyOnceWith({
      kind: "applePurchaseEvidence",
    });
    expect(
      await host(async () => ({
        evidence: { ...evidence, entitled: true },
      })).bridge.applePurchaseEvidence(),
    ).toBeNull();
    expect(
      await host(async () => ({
        evidence: { ...evidence, signedTransaction: "plain receipt" },
      })).bridge.applePurchaseEvidence(),
    ).toBeNull();
  });

  it("reads only the fixed pending Pro route and acknowledges the exact displayed revision", async () => {
    const { bridge, post } = host(async (message) =>
      message.kind === "pendingAppRoute"
        ? { pending: { route: "pro", revision: 2 } }
        : { ok: true, revision: 2 },
    );
    expect(await bridge.pendingAppRoute()).toEqual({
      route: "pro",
      revision: 2,
    });
    expect(await bridge.acknowledgeAppRoute(2)).toBe(true);
    expect(await bridge.acknowledgeAppRoute(1)).toBe(false);
    expect(post).toHaveBeenLastCalledWith({
      kind: "acknowledgeAppRoute",
      revision: 1,
    });
    const count = post.mock.calls.length;
    expect(await bridge.acknowledgeAppRoute(NaN)).toBe(false);
    expect(post).toHaveBeenCalledTimes(count);
  });

  it.each([
    { route: "checkout", revision: 2 },
    { route: "pro", revision: "2" },
    { route: "pro", revision: 1.5 },
    { route: "pro", revision: 2, accountId: "other" },
  ])("rejects arbitrary app navigation input %j", async (pending) => {
    expect(
      await host(async () => ({ pending })).bridge.pendingAppRoute(),
    ).toBeNull();
  });
});
