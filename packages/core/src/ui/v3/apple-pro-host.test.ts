import { describe, it, expect, vi } from "vitest";
import {
  FEATURE_REGISTRY,
  type BenefitAccessSnapshot,
} from "@still/shared-types";
import { initialAccessSnapshot } from "../../entitlement/access-policy.js";
import {
  createAppleProHost,
  type AppleProHostDeps,
  type AppleProAccount,
} from "./apple-pro-host.js";
import type {
  NativeLifetimeOffering,
  NativeProResult,
} from "../../native/bridge.js";

function access(
  state: "locked" | "purchased" | "checking" | "verification_required",
) {
  const value = initialAccessSnapshot();
  return {
    ...value,
    states: Object.fromEntries(
      FEATURE_REGISTRY.map((row) => [
        row.id,
        row.tier === "pro" ? state : "free",
      ]),
    ),
  } as BenefitAccessSnapshot;
}
const offer: NativeLifetimeOffering = {
  productId: "still_pro_v3",
  offeringId: "still_pro_v3",
  packageId: "$rc_lifetime",
  package: "still-pro-v3",
  kind: "lifetime",
  price: "$9.99",
  currencyCode: "USD",
};
const owned: NativeProResult = {
  outcome: "purchased",
  receipt: "entitled",
  productId: "still_pro_v3",
};
async function harness(overrides: Partial<AppleProHostDeps> = {}) {
  let account: AppleProAccount | null = null;
  const deps: AppleProHostDeps = {
    bridge: {
      available: true,
      proOffering: vi.fn(async () => offer),
      purchasePro: vi.fn(async () => owned),
      restorePro: vi.fn(async () => ({
        ...owned,
        outcome: "restored" as const,
      })),
      pendingAppRoute: vi.fn(async () => null),
      acknowledgeAppRoute: vi.fn(async () => true),
    },
    readAccess: vi.fn(async () => access("locked")),
    verifyLocalPurchase: vi.fn(async () => access("purchased")),
    account: () => account,
    ownershipRevision: () => 0,
    readLinkEligibility: vi.fn(async () => ({ ownershipRevision: 0 })),
    linkPurchase: vi.fn(async () => ({
      status: "linked" as const,
      ownershipRevision: 1,
    })),
    signIn: vi.fn(),
    chooseOtherAccount: vi.fn(async () => {}),
    publish: vi.fn(),
    operationId: () => "00000000-0000-4000-8000-000000000001",
    ...overrides,
  };
  const host = createAppleProHost(deps);
  await host.refresh();
  const settle = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  return {
    host,
    deps,
    settle,
    setAccount: (next: AppleProAccount | null) => {
      account = next;
      host.accountChanged();
    },
  };
}
const user = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "qa@still.test",
  revision: 1,
  confirmed: true,
};
describe("real Apple Pro host composition", () => {
  it("a throwing canonical measurement completion cannot replace native purchase success", async () => {
    const h = await harness({purchaseAnalytics:{begin:async()=>()=>{throw new Error("optional measurement failed");}}});
    h.host.props([]).native.onBuy?.();
    await vi.waitFor(()=>expect(h.host.props([]).purchase.state).toBe("success"));
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce();
    h.host.stop();
  });

  it("rechecks account and stopped scope after optional analytics preparation before charging", async () => {
    for (const change of ["account", "stop"] as const) {
      let finish!: (value: null) => void;
      const begin = vi.fn(() => new Promise<null>(resolve => { finish = resolve; }));
      const h = await harness({ purchaseAnalytics: { begin } });
      h.host.props([]).native.onBuy?.();
      await vi.waitFor(() => expect(begin).toHaveBeenCalledOnce());
      if (change === "account") h.setAccount(user); else h.host.stop();
      finish(null);
      await h.settle();
      expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
      h.host.stop();
    }
  });

  it("measures a deliberate offer opening once, dismissal, and native start without inventing a sale", async () => {
    const analytics = { track: vi.fn() };
    const { host, settle } = await harness({ analytics });
    host.settings().pro?.onBuy?.();
    host.settings().pro?.onBuy?.();
    host.props([]).native.onBuy?.();
    await settle();
    host.props([]).onBack?.();
    host.close();
    expect(analytics.track.mock.calls).toEqual([
      ["paywall_viewed", { trigger: "upgrade_button", where: "app" }],
      ["purchase_started", { purchase_origin: "unknown", product: "still-pro-v3" }],
      ["paywall_dismissed", { trigger: "upgrade_button", where: "app" }],
    ]);
    // A generic accepted local proof could be an Apple sandbox review right, never a live sale.
    expect(analytics.track.mock.calls.some(([name]) => name === "purchase_completed" || name === "purchase_recorded")).toBe(false);
  });

  it("does not count Verify purchase or Restore as an offer or a new purchase", async () => {
    const analytics = { track: vi.fn() };
    const { host, settle } = await harness({ analytics });
    host.show(); await settle();
    host.close();
    host.props([]).native.onRestore?.(); await settle();
    expect(analytics.track).not.toHaveBeenCalled();
  });

  it("a failing analytics port cannot prevent purchase, and stopped callbacks report nothing", async () => {
    const analytics = { track: vi.fn(() => { throw new Error("measurement unavailable"); }) };
    const { host, deps, settle } = await harness({ analytics });
    host.settings().pro?.onBuy?.();
    host.props([]).native.onBuy?.(); await settle();
    expect(deps.bridge.purchasePro).toHaveBeenCalledOnce();
    expect(host.props([]).purchase.state).toBe("success");
    host.stop();
    analytics.track.mockClear();
    host.settings().pro?.onBuy?.(); host.close();
    expect(analytics.track).not.toHaveBeenCalled();
  });

  it("buys accountlessly using the localized exact offer and confirms only native signed-rights readback", async () => {
    const { host, deps, settle } = await harness();
    host.props([]).native.onBuy?.();
    await settle();
    expect(deps.bridge.purchasePro).toHaveBeenCalledWith(offer);
    expect(deps.verifyLocalPurchase).toHaveBeenCalledOnce();
    expect(host.props([]).purchase).toEqual({
      state: "success",
      confirmed: true,
    });
    expect(deps.linkPurchase).not.toHaveBeenCalled();
    expect(deps.signIn).not.toHaveBeenCalled();
  });
  it("does not confirm native feedback while signed-rights readback remains held", async () => {
    const { host, deps, settle } = await harness();
    vi.mocked(deps.verifyLocalPurchase).mockResolvedValue(access("checking"));
    const buy = host.props([]).native.onBuy!;
    buy();
    await settle();
    expect(host.props([]).purchase).toEqual({
      state: "pending",
      verificationRequired: true,
    });
    buy();
    await settle();
    expect(deps.bridge.purchasePro).toHaveBeenCalledOnce();
    vi.mocked(deps.verifyLocalPurchase).mockResolvedValue(access("purchased"));
    await host.refresh();
    expect(host.props([]).purchase).toEqual({
      state: "success",
      confirmed: true,
    });
  });
  it("cancellation leaves no purchase success or linking request", async () => {
    const { host, deps, settle } = await harness();
    vi.mocked(deps.bridge.purchasePro).mockResolvedValue({
      outcome: "cancelled",
      receipt: "noSignal",
    });
    host.props([]).native.onBuy?.();
    await settle();
    expect(host.props([]).purchase.state).toBe("idle");
    expect(deps.verifyLocalPurchase).not.toHaveBeenCalled();
  });
  it("rechecks existing ownership before charging and rejects changed localized offers", async () => {
    const { host, deps, settle } = await harness();
    vi.mocked(deps.readAccess).mockResolvedValue(access("purchased"));
    host.props([]).native.onBuy?.();
    await settle();
    expect(deps.bridge.purchasePro).not.toHaveBeenCalled();
    vi.mocked(deps.readAccess).mockResolvedValue(access("locked"));
    await host.refresh();
    vi.mocked(deps.bridge.proOffering).mockResolvedValue({
      ...offer,
      price: "€9.99",
      currencyCode: "EUR",
    });
    host.props([]).native.onBuy?.();
    await settle();
    expect(deps.bridge.purchasePro).not.toHaveBeenCalled();
    // The Buy never reached the App Store, so the copy must not suggest a charge (ISS-0070).
    expect(host.props([]).purchase).toEqual({ state: "failed", notCharged: true });
    expect(host.settings().pro).toMatchObject({ state: "failed", notCharged: true });
  });
  it("a Buy the App Store never started reports nothing charged (ISS-0070)", async () => {
    const { host, deps, settle } = await harness();
    vi.mocked(deps.bridge.purchasePro).mockResolvedValueOnce({
      outcome: "unavailable",
      receipt: "noSignal",
    });
    host.props([]).native.onBuy?.();
    await settle();
    expect(deps.bridge.purchasePro).toHaveBeenCalledOnce();
    expect(deps.verifyLocalPurchase).not.toHaveBeenCalled();
    expect(host.props([]).purchase).toEqual({ state: "failed", notCharged: true });
    expect(host.settings().pro).toMatchObject({ state: "failed", notCharged: true });
    expect(host.settings().pro?.verificationRequired).toBeUndefined();
    // Try again buys normally once the App Store can start the purchase.
    host.settings().pro?.onRetry?.();
    await settle();
    expect(host.props([]).purchase).toEqual({ state: "success", confirmed: true });
    expect(host.settings().pro?.notCharged).toBeUndefined();
  });
  it.each([
    { label: "a failed native reply", result: { outcome: "failed", receipt: "noSignal" } },
    { label: "a stale identity", result: { outcome: "staleIdentity", receipt: "noSignal" } },
  ] as const)("$label keeps the ambiguous failed state, never nothing charged", async ({ result }) => {
    const { host, deps, settle } = await harness();
    vi.mocked(deps.bridge.purchasePro).mockResolvedValueOnce(result);
    host.props([]).native.onBuy?.();
    await settle();
    expect(host.props([]).purchase).toEqual({ state: "failed" });
    expect(host.settings().pro?.notCharged).toBeUndefined();
  });
  it("a lost native reply keeps the ambiguous failed state", async () => {
    const { host, deps, settle } = await harness();
    vi.mocked(deps.bridge.purchasePro).mockRejectedValueOnce(new Error("reply lost"));
    host.props([]).native.onBuy?.();
    await settle();
    expect(host.props([]).purchase).toEqual({ state: "failed" });
    expect(host.settings().pro?.notCharged).toBeUndefined();
  });
  it.each(["checking", "verification_required"] as const)(
    "held %s access cannot buy",
    async (state) => {
      const { host, deps, settle } = await harness();
      vi.mocked(deps.readAccess).mockResolvedValue(access(state));
      host.props([]).native.onBuy?.();
      await settle();
      expect(deps.bridge.purchasePro).not.toHaveBeenCalled();
    },
  );
  it("Restore distinguishes conclusive nothing from missing signal and failure", async () => {
    const { host, deps, settle } = await harness();
    vi.mocked(deps.bridge.restorePro).mockResolvedValue({
      outcome: "nothing",
      receipt: "verifiedNotEntitled",
    });
    host.props([]).native.onRestore?.();
    await settle();
    expect(host.settings().restore?.state).toBe("nothing");
    vi.mocked(deps.bridge.restorePro).mockResolvedValue({
      outcome: "nothing",
      receipt: "noSignal",
    });
    host.props([]).native.onRestore?.();
    await settle();
    expect(host.settings().restore?.state).toBe("verify");
    vi.mocked(deps.bridge.restorePro).mockRejectedValue(new Error("offline"));
    host.settings().restore?.onAction?.();
    await settle();
    expect(host.settings().restore?.state).toBe("failed");
  });
  it("Restore owned readback succeeds without account or automatic link", async () => {
    const { host, deps, settle } = await harness();
    host.props([]).native.onRestore?.();
    await settle();
    expect(host.settings().restore?.state).toBe("restored");
    expect(deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("ordinary sign-in never links; deliberate link asks for confirmed intended account", async () => {
    const { host, deps, settle, setAccount } = await harness();
    host.props([]).native.onBuy?.();
    await settle();
    setAccount(user);
    expect(host.settings().link).toBeUndefined();
    expect(deps.linkPurchase).not.toHaveBeenCalled();
    await host.requestLink();
    expect(host.settings().link?.email).toBe(user.email);
    expect(deps.linkPurchase).not.toHaveBeenCalled();
    host.settings().link?.onConfirm?.();
    await settle();
    expect(deps.linkPurchase).toHaveBeenCalledWith({
      intendedAccountId: user.id,
      expectedOwnershipRevision: 0,
      operationId: "00000000-0000-4000-8000-000000000001",
    });
    expect(host.settings().link?.state).toBe("linked");
  });
  it("link failure preserves local rights and retry requests fresh consent", async () => {
    const { host, deps, settle, setAccount } = await harness();
    host.props([]).native.onBuy?.();
    await settle();
    setAccount(user);
    vi.mocked(deps.linkPurchase).mockResolvedValue({
      status: "unavailable",
    });
    await host.requestLink();
    host.settings().link?.onConfirm?.();
    await settle();
    expect(host.settings().link?.state).toBe("failed");
    expect(host.props([]).access.state).toBe("owned");
    host.settings().link?.onRetry?.();
    await settle();
    expect(host.settings().link?.state).toBe("confirm");
    expect(deps.linkPurchase).toHaveBeenCalledOnce();
  });
  it("account replacement fences a captured link callback and delayed link reply", async () => {
    const { host, deps, settle, setAccount } = await harness();
    host.props([]).native.onBuy?.();
    await settle();
    setAccount(user);
    await host.requestLink();
    const stale = host.settings().link?.onConfirm;
    const staleOther = host.settings().link?.onChooseOther;
    setAccount({ ...user, revision: 2 });
    stale?.();
    staleOther?.();
    await settle();
    expect(deps.linkPurchase).not.toHaveBeenCalled();
    expect(deps.chooseOtherAccount).not.toHaveBeenCalled();
    expect(host.settings().link).toBeUndefined();
    let finish!: (value: {
      status: "linked";
      ownershipRevision: number;
    }) => void;
    vi.mocked(deps.linkPurchase).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await host.requestLink();
    host.settings().link?.onConfirm?.();
    await settle();
    setAccount(null);
    finish({ status: "linked" as const, ownershipRevision: 1 });
    await settle();
    expect(host.settings().link).toBeUndefined();
  });
  it("explicit link intent can ask sign-in and resumes only to account confirmation", async () => {
    const { host, deps, settle, setAccount } = await harness();
    host.props([]).native.onBuy?.();
    await settle();
    await host.requestLink();
    expect(deps.signIn).toHaveBeenCalledOnce();
    setAccount(user);
    await settle();
    expect(host.settings().link?.state).toBe("confirm");
    expect(deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("an older confirmation from the same account cannot bypass reopened link consent", async () => {
    const { host, deps, settle, setAccount } = await harness();
    host.props([]).native.onBuy?.();
    await settle();
    setAccount(user);
    await host.requestLink();
    const stale = host.settings().link?.onConfirm;
    await host.requestLink();
    stale?.();
    await settle();
    expect(deps.linkPurchase).not.toHaveBeenCalled();
    host.settings().link?.onConfirm?.();
    await settle();
    expect(deps.linkPurchase).toHaveBeenCalledOnce();
  });
  it("a purchase whose signed verification fails cannot charge again through a stale callback", async () => {
    const { host, deps, settle } = await harness();
    vi.mocked(deps.verifyLocalPurchase).mockRejectedValue(
      new Error("verification unavailable"),
    );
    const buy = host.props([]).native.onBuy!;
    buy();
    await settle();
    expect(host.props([]).purchase.state).toBe("failed");
    buy();
    await settle();
    expect(deps.bridge.purchasePro).toHaveBeenCalledOnce();
    host.settings().pro?.onRetry?.();
    await settle();
    expect(deps.bridge.purchasePro).toHaveBeenCalledOnce();
  });
  it("cold/warm route opens represented screen and acknowledges native revision", async () => {
    const { host, deps } = await harness();
    vi.mocked(deps.bridge.pendingAppRoute).mockResolvedValue({
      route: "pro",
      revision: 3,
    });
    await host.route();
    expect(host.open).toBe(true);
    expect(deps.bridge.acknowledgeAppRoute).toHaveBeenCalledWith(3);
    host.close();
    vi.mocked(deps.bridge.pendingAppRoute).mockResolvedValue({
      route: "pro",
      revision: 4,
    });
    await host.route();
    expect(host.open).toBe(true);
    expect(deps.bridge.acknowledgeAppRoute).toHaveBeenCalledWith(4);
  });
  it("leaves the sync route pending for the sync handler", async () => {
    const { host, deps } = await harness();
    vi.mocked(deps.bridge.pendingAppRoute).mockResolvedValue({
      route: "sync",
      revision: 5,
    });
    await host.route();
    expect(host.open).toBe(false);
    expect(deps.bridge.acknowledgeAppRoute).not.toHaveBeenCalled();
  });
  it("unmount fences late native feedback and route acknowledgments", async () => {
    const { host, deps, settle } = await harness();
    let finish!: (value: NativeProResult) => void;
    vi.mocked(deps.bridge.purchasePro).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    host.props([]).native.onBuy?.();
    await settle();
    host.stop();
    finish(owned);
    await settle();
    expect(deps.verifyLocalPurchase).not.toHaveBeenCalled();
    await host.route();
    expect(deps.bridge.acknowledgeAppRoute).not.toHaveBeenCalled();
  });
});

describe("accepted access and purchaser-only link provenance", () => {
  it("accepted native access overrides a delayed older host read without renewing it", async () => {
    const { host, deps } = await harness();
    let finish!: (value: BenefitAccessSnapshot) => void;
    vi.mocked(deps.readAccess).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reading = host.refresh();
    host.observeAccess(access("verification_required"));
    finish(access("purchased"));
    await reading;
    expect(host.props([]).access.state).toBe("verify");
    expect(host.canLink).toBe(false);
    expect(deps.verifyLocalPurchase).not.toHaveBeenCalled();
  });
  it("a newer accepted hold prevents a charge despite a delayed old locked preflight", async () => {
    const { host, deps, settle } = await harness();
    let finish!: (value: BenefitAccessSnapshot) => void;
    vi.mocked(deps.readAccess).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    host.props([]).native.onBuy?.();
    await settle();
    host.observeAccess(access("verification_required"));
    finish(access("locked"));
    await settle();
    expect(deps.bridge.purchasePro).not.toHaveBeenCalled();
    expect(host.props([]).access.state).toBe("verify");
  });
  it.each(["family", "protected", "account-only"])(
    "generic %s owned access has no Apple link action without native purchaser provenance",
    async () => {
      const { host, deps, settle } = await harness();
      vi.mocked(deps.readLinkEligibility!).mockResolvedValue(null);
      host.observeAccess(access("purchased"));
      await settle();
      expect(host.props([]).access.state).toBe("owned");
      expect(host.canLink).toBe(false);
      await host.requestLink();
      expect(deps.signIn).not.toHaveBeenCalled();
      expect(deps.linkPurchase).not.toHaveBeenCalled();
    },
  );
  it("a formerly eligible CTA rechecks native provenance before opening sign-in", async () => {
    const { host, deps, settle } = await harness();
    host.observeAccess(access("purchased"));
    await settle();
    expect(host.canLink).toBe(true);
    vi.mocked(deps.readLinkEligibility!).mockResolvedValue(null);
    await host.requestLink();
    expect(deps.signIn).not.toHaveBeenCalled();
    expect(host.canLink).toBe(false);
  });
  it("confirming an account rereads local purchaser eligibility before fulfillment", async () => {
    const { host, deps, settle, setAccount } = await harness();
    host.observeAccess(access("purchased"));
    await settle();
    setAccount(user);
    await host.requestLink();
    vi.mocked(deps.readLinkEligibility!).mockResolvedValue(null);
    host.settings().link?.onConfirm?.();
    await settle();
    expect(deps.linkPurchase).not.toHaveBeenCalled();
    expect(host.settings().link?.state).toBe("failed");
  });
  it("a newer accepted owned snapshot fences an older purchaser confirmation read", async () => {
    const { host, deps, settle, setAccount } = await harness();
    host.observeAccess(access("purchased"));
    await settle();
    setAccount(user);
    await host.requestLink();
    let finish!: (value: { ownershipRevision: number }) => void;
    vi.mocked(deps.readLinkEligibility!)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(null);
    host.settings().link?.onConfirm?.();
    await settle();
    host.observeAccess(access("purchased"));
    finish({ ownershipRevision: 0 });
    await settle();
    expect(deps.linkPurchase).not.toHaveBeenCalled();
    expect(host.canLink).toBe(false);
  });
  it("signed fulfillment failure exposes verification recovery and never charges again", async () => {
    const { host, deps, settle } = await harness();
    vi.mocked(deps.verifyLocalPurchase).mockRejectedValueOnce(
      new Error("verification offline"),
    );
    host.props([]).native.onBuy?.();
    await settle();
    expect(host.props([]).purchase).toEqual({
      state: "failed",
      verificationRequired: true,
    });
    host.props([]).native.onBuy?.();
    await settle();
    expect(deps.bridge.purchasePro).toHaveBeenCalledOnce();
    host.props([]).native.onVerify?.();
    await settle();
    expect(deps.verifyLocalPurchase).toHaveBeenCalledTimes(2);
    expect(deps.bridge.purchasePro).toHaveBeenCalledOnce();
    expect(host.props([]).purchase).toEqual({
      state: "success",
      confirmed: true,
    });
  });
});

describe("Opus pending fulfillment, consent recovery and final charge fence", () => {
  it.each(["buy", "restore"] as const)(
    "%s keeps verification recovery when signed fulfillment rejects despite generic owned access",
    async (kind) => {
      const { host, deps, settle } = await harness();
      vi.mocked(deps.verifyLocalPurchase).mockRejectedValue(
        new Error("Signed local proof unavailable"),
      );
      if (kind === "buy") host.props([]).native.onBuy?.();
      else host.props([]).native.onRestore?.();
      await settle();
      host.observeAccess(access("purchased"));
      await settle();
      await host.refresh();
      expect(host.props([]).purchase.verificationRequired).toBe(true);
      expect(host.props([]).purchase.confirmed).not.toBe(true);
      expect(host.settings().restore?.state).not.toBe("restored");
      host.props([]).native.onBuy?.();
      await settle();
      expect(deps.bridge.purchasePro).toHaveBeenCalledTimes(
        kind === "buy" ? 1 : 0,
      );
      expect(deps.bridge.restorePro).toHaveBeenCalledTimes(
        kind === "restore" ? 1 : 0,
      );
    },
  );
  it("a fulfilled held local verification cannot complete from a newer generic owned snapshot", async () => {
    const { host, deps, settle } = await harness();
    vi.mocked(deps.verifyLocalPurchase).mockRejectedValueOnce(
      new Error("Offline"),
    );
    host.props([]).native.onBuy?.();
    await settle();
    let finish!: (value: BenefitAccessSnapshot) => void;
    vi.mocked(deps.verifyLocalPurchase).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refreshing = host.refresh();
    host.observeAccess(access("purchased"));
    finish(access("verification_required"));
    await refreshing;
    expect(host.props([]).purchase.verificationRequired).toBe(true);
    expect(host.props([]).purchase.confirmed).not.toBe(true);
    expect(deps.bridge.purchasePro).toHaveBeenCalledOnce();
  });
  it.each(["acquisition", "recovery"] as const)(
    "a delayed old owned verifier during %s cannot complete after a newer accepted owned snapshot",
    async (phase) => {
      const { host, deps, settle } = await harness();
      if (phase === "recovery") {
        vi.mocked(deps.verifyLocalPurchase).mockRejectedValueOnce(
          new Error("Offline"),
        );
        host.props([]).native.onBuy?.();
        await settle();
      }
      let finish!: (value: BenefitAccessSnapshot) => void;
      vi.mocked(deps.verifyLocalPurchase).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      if (phase === "acquisition") host.props([]).native.onBuy?.();
      else void host.refresh();
      await settle();
      host.observeAccess(access("purchased"));
      finish(access("purchased"));
      await settle();
      expect(host.props([]).purchase.verificationRequired).toBe(true);
      expect(host.props([]).purchase.confirmed).not.toBe(true);
      expect(deps.bridge.purchasePro).toHaveBeenCalledOnce();
    },
  );
  it("a same-account eligible observation during confirmation is re-read once and then links", async () => {
    const { host, deps, settle, setAccount } = await harness();
    host.observeAccess(access("purchased"));
    await settle();
    setAccount(user);
    await host.requestLink();
    let finish!: (value: { ownershipRevision: number }) => void;
    vi.mocked(deps.readLinkEligibility!)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ ownershipRevision: 0 });
    host.settings().link?.onConfirm?.();
    await settle();
    host.observeAccess(access("purchased"));
    await settle();
    finish({ ownershipRevision: 0 });
    await settle();
    expect(deps.linkPurchase).toHaveBeenCalledOnce();
    expect(host.settings().link?.state).toBe("linked");
  });
  it("freshly reconciles a confirmed account before any new charge", async () => {
    const h = await harness();
    const refreshAccountAccess = vi.fn(async () => access("purchased"));
    Object.assign(h.deps, {refreshAccountAccess});
    h.setAccount(user);
    h.host.props([]).native.onBuy?.();
    await vi.waitFor(() => expect(refreshAccountAccess).toHaveBeenCalled());
    await h.settle();
    expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
    expect(h.host.props([]).access.state).toBe("owned");
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("Restore finds an account purchase even with conclusive empty StoreKit and no sales offer", async () => {
    const h = await harness();
    Object.assign(h.deps, {refreshAccountAccess: vi.fn(async () => access("purchased"))});
    h.setAccount(user);
    vi.mocked(h.deps.bridge.restorePro).mockResolvedValue({outcome:"nothing",receipt:"verifiedNotEntitled"});
    vi.mocked(h.deps.bridge.proOffering).mockResolvedValue(null);
    await h.host.refresh();
    h.host.props([]).native.onRestore?.();
    await vi.waitFor(() => expect(h.host.settings().restore?.state).toBe("restored"));
    expect(h.deps.verifyLocalPurchase).not.toHaveBeenCalled();
    expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("ambiguous account check keeps accepted benefits and holds a new charge", async () => {
    const h = await harness();
    Object.assign(h.deps, {refreshAccountAccess: vi.fn(async () => {throw new Error("unknown account");})});
    h.setAccount(user);
    h.host.observeAccess(access("purchased"));
    h.host.props([]).native.onBuy?.();
    await h.settle();
    expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
    expect(h.host.props([]).access.state).toBe("owned");
  });
  it("an old account refresh cannot publish after A to B to A", async () => {
    const h = await harness();
    const finishes: Array<(value: BenefitAccessSnapshot) => void> = [];
    Object.assign(h.deps, {refreshAccountAccess: vi.fn(() => new Promise(resolve => {finishes.push(resolve);} ))});
    h.setAccount(user);
    h.host.props([]).native.onBuy?.();
    await vi.waitFor(() => expect(finishes.length).toBeGreaterThan(0));
    h.setAccount({...user,id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",revision:2});
    h.setAccount({...user,revision:3});
    finishes[0]!(access("purchased"));
    await h.settle();
    expect(h.host.props([]).access.state).toBe("none");
    expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
  });
});


describe("Apple account Restore ambiguity", () => {
  it("an unknown account and empty StoreKit preserve accepted benefits while Restore stays unverified", async () => {
    const h = await harness();
    Object.assign(h.deps, {refreshAccountAccess: vi.fn(async () => {throw new Error("Unknown account");})});
    h.setAccount(user);
    vi.mocked(h.deps.readAccess).mockResolvedValue(access("purchased"));
    h.host.observeAccess(access("purchased"));
    vi.mocked(h.deps.bridge.restorePro).mockResolvedValue({outcome: "nothing", receipt: "verifiedNotEntitled"});
    h.host.props([]).native.onRestore?.();
    await vi.waitFor(() => expect(h.host.settings().restore?.state).toBe("verify"));
    expect(h.host.props([]).access.state).toBe("owned");
    expect(h.deps.verifyLocalPurchase).not.toHaveBeenCalled();
  });
  it("an unknown account does not stop a verified independent local Restore", async () => {
    const h = await harness();
    Object.assign(h.deps, {refreshAccountAccess: vi.fn(async () => {throw new Error("Unknown account");})});
    h.setAccount(user);
    h.host.props([]).native.onRestore?.();
    await vi.waitFor(() => expect(h.host.settings().restore?.state).toBe("restored"));
    expect(h.deps.verifyLocalPurchase).toHaveBeenCalledOnce();
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
});


describe("Apple operation cleanup ownership", () => {
  it.each(["lost", "failed", "cancelled", "unavailable", "nothing"] as const)("a later %s Restore reply after account replacement preserves an earlier pending Buy", async reply => {
    const h = await harness();
    vi.mocked(h.deps.verifyLocalPurchase).mockResolvedValueOnce(access("checking"));
    h.host.props([]).native.onBuy?.();
    await h.settle();
    expect(h.host.props([]).purchase).toEqual({state:"pending", verificationRequired:true});
    let finish!: (value: NativeProResult) => void;
    let fail!: (reason: Error) => void;
    vi.mocked(h.deps.bridge.restorePro).mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    }));
    h.host.props([]).native.onRestore?.();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.setAccount(user);
    if (reply === "lost") fail(new Error("Restore reply lost"));
    else finish({outcome:reply, receipt:reply === "nothing" ? "verifiedNotEntitled" : "noSignal"});
    await h.settle();
    expect(h.host.props([]).purchase).toEqual({state:"pending", verificationRequired:true});
    await h.host.refresh();
    expect(h.host.props([]).purchase).toEqual({state:"success", confirmed:true});
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce();
    expect(h.deps.bridge.restorePro).toHaveBeenCalledOnce();
    expect(h.deps.verifyLocalPurchase).toHaveBeenCalledTimes(2);
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("a failed/noSignal native reply after account replacement is unknown and cannot permit another charge", async () => {
    const h = await harness();
    let finish!: (value: NativeProResult) => void;
    vi.mocked(h.deps.bridge.purchasePro).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    h.host.props([]).native.onBuy?.();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.setAccount(user);
    finish({outcome:"failed", receipt:"noSignal"});
    await h.settle();
    expect(h.host.props([]).purchase).toEqual({state:"pending", verificationRequired:true});
    h.host.props([]).native.onBuy?.();
    await h.settle();
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce();
    expect(h.deps.verifyLocalPurchase).not.toHaveBeenCalled();
  });
  it.each(["buy", "restore"] as const)("a confirmed unavailable native %s after account replacement releases an empty acquisition", async kind => {
    const h = await harness();
    let finish!: (value: NativeProResult) => void;
    const acquire = kind === "buy" ? h.deps.bridge.purchasePro : h.deps.bridge.restorePro;
    vi.mocked(acquire).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    if (kind === "buy") h.host.props([]).native.onBuy?.();
    else h.host.props([]).native.onRestore?.();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.setAccount(user);
    finish({outcome:"unavailable", receipt:"noSignal"});
    await h.settle();
    // A refused native Buy never reached the App Store; a refused Restore is not a purchase.
    expect(h.host.props([]).purchase).toEqual(
      kind === "buy" ? {state:"failed", notCharged:true} : {state:"failed"});
    expect(h.deps.verifyLocalPurchase).not.toHaveBeenCalled();
    h.host.props([]).native.onBuy?.();
    await h.settle();
    expect(h.host.props([]).purchase).toEqual({state:"success", confirmed:true});
  });
  it("a conclusive empty native Restore after account replacement does not invent a purchase awaiting recovery", async () => {
    const h = await harness();
    let finish!: (value: NativeProResult) => void;
    vi.mocked(h.deps.bridge.restorePro).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    h.host.props([]).native.onRestore?.();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.setAccount(user);
    finish({outcome:"nothing", receipt:"verifiedNotEntitled"});
    await h.settle();
    expect(h.host.props([]).purchase).toEqual({state:"idle"});
    expect(h.host.settings().restore?.state).toBe("verify");
    expect(h.deps.verifyLocalPurchase).not.toHaveBeenCalled();
    h.host.props([]).native.onBuy?.();
    await h.settle();
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce();
    expect(h.host.props([]).purchase).toEqual({state:"success", confirmed:true});
  });
  it("an account change during native cancellation releases Buy only after Apple confirms cancellation", async () => {
    const h = await harness();
    let finish!: (value: NativeProResult) => void;
    vi.mocked(h.deps.bridge.purchasePro).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    h.host.props([]).native.onBuy?.();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.setAccount(user);
    h.host.props([]).native.onBuy?.();
    await h.settle();
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce();
    finish({outcome:"cancelled", receipt:"noSignal"});
    await h.settle();
    expect(h.host.props([]).purchase).toEqual({state:"idle"});
    expect(h.deps.verifyLocalPurchase).not.toHaveBeenCalled();
    h.host.props([]).native.onBuy?.();
    await h.settle();
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledTimes(2);
    expect(h.host.props([]).purchase).toEqual({state:"success", confirmed:true});
  });
  it("an account change with a lost native reply keeps Buy held for current signed recovery", async () => {
    const h = await harness();
    let fail!: (reason: Error) => void;
    vi.mocked(h.deps.bridge.purchasePro).mockImplementationOnce(() => new Promise((_resolve, reject) => {fail = reject;}));
    h.host.props([]).native.onBuy?.();
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    h.setAccount(user);
    fail(new Error("Native response lost"));
    await h.settle();
    expect(h.host.props([]).purchase).toEqual({state:"pending", verificationRequired:true});
    h.host.props([]).native.onBuy?.();
    await h.host.refresh();
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce();
    expect(h.deps.verifyLocalPurchase).toHaveBeenCalledOnce();
    expect(h.host.props([]).purchase).toEqual({state:"success", confirmed:true});
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
  it.each(["buy", "restore"] as const)("an account change while native %s is pending retains signed recovery without a second acquisition", async kind => {
    const h = await harness();
    let finish!: (value: NativeProResult) => void;
    const acquire = kind === "buy" ? h.deps.bridge.purchasePro : h.deps.bridge.restorePro;
    vi.mocked(acquire).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const native = h.host.props([]).native;
    if (kind === "buy") native.onBuy?.();
    else native.onRestore?.();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.setAccount(user);
    await h.host.refresh();
    h.host.props([]).native.onBuy?.();
    h.host.props([]).native.onRestore?.();
    await h.settle();
    expect(acquire).toHaveBeenCalledOnce();
    expect(h.deps.verifyLocalPurchase).not.toHaveBeenCalled();
    finish({...owned, outcome: kind === "buy" ? "purchased" : "restored"});
    await h.settle();
    expect(h.host.props([]).purchase).toEqual({state:"pending", verificationRequired:true});
    await h.host.refresh();
    expect(h.deps.verifyLocalPurchase).toHaveBeenCalledOnce();
    expect(h.host.props([]).purchase).toEqual(kind === "buy" ? {state:"success", confirmed:true} : {state:"idle"});
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledTimes(kind === "buy" ? 1 : 0);
    expect(h.deps.bridge.restorePro).toHaveBeenCalledTimes(kind === "restore" ? 1 : 0);
  });
  it.each(["account", "offering"] as const)("an account change during %s preflight releases Buy for the new account", async phase => {
    const h = await harness();
    const refreshAccountAccess = vi.fn(async () => access("locked"));
    Object.assign(h.deps, {refreshAccountAccess});
    h.setAccount(user);
    await h.host.refresh();
    await h.settle();
    let release!: () => void;
    if (phase === "account") refreshAccountAccess.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve(access("locked"));
    }));
    else vi.mocked(h.deps.bridge.proOffering).mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve(offer);
    }));
    const buy = h.host.props([]).native.onBuy!;
    buy();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(h.host.props([]).purchase.state).toBe("pending");
    h.setAccount({...user, id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd", revision:2});
    release();
    await h.host.refresh();
    await h.settle();
    expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
    expect(h.host.props([]).purchase.state).toBe("idle");
    buy();
    await vi.waitFor(() => expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce());
    await h.settle();
    expect(h.host.props([]).purchase).toEqual({state:"success", confirmed:true});
  });
  it("an account change preserves recovery after native purchase has completed", async () => {
    const h = await harness();
    let finish!: (value: BenefitAccessSnapshot) => void;
    vi.mocked(h.deps.verifyLocalPurchase).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    h.host.props([]).native.onBuy?.();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.setAccount(user);
    expect(h.host.props([]).purchase).toEqual({state:"pending", verificationRequired:true});
    h.host.props([]).native.onBuy?.();
    finish(access("purchased"));
    await h.settle();
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce();
    await h.host.refresh();
    expect(h.deps.verifyLocalPurchase).toHaveBeenCalledTimes(2);
    expect(h.host.props([]).purchase).toEqual({state:"success", confirmed:true});
  });
  it("an earlier account link completion cannot release a replacement account's purchase", async () => {
    const h = await harness();
    h.host.observeAccess(access("purchased"));
    h.setAccount(user);
    await h.settle();
    await h.host.requestLink();
    let finishLink!: (value: {status: "linked"; ownershipRevision: number}) => void;
    vi.mocked(h.deps.linkPurchase).mockImplementation(() => new Promise(resolve => {finishLink = resolve;}));
    h.host.settings().link?.onConfirm?.();
    await vi.waitFor(() => expect(finishLink).toBeTypeOf("function"));
    h.setAccount({...user,id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd", revision:2});
    h.host.observeAccess(access("locked"));
    vi.mocked(h.deps.bridge.purchasePro).mockImplementation(() => new Promise(() => {}));
    h.host.props([]).native.onBuy?.();
    await vi.waitFor(() => expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce());
    finishLink({status:"linked",ownershipRevision:1});
    await h.settle();
    h.host.props([]).native.onRestore?.();
    await h.settle();
    expect(h.deps.bridge.restorePro).not.toHaveBeenCalled();
  });
});

// ISS-0071 (owner decision, option B; ADR 0005): on Apple, Get Still Pro asks a signed-out person
// to sign in first, with "Buy without an account" under it. The purchase then continues by itself,
// and a purchase started signed in links to that account through the existing guarded link path.
describe("Apple Still Pro purchase starts with sign-in (ISS-0071)", () => {
  async function signInCapable() {
    const h = await harness();
    h.deps.canSignIn = () => true;
    return h;
  }
  const other = { ...user, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", revision: 2 };
  it("signed out, Get Still Pro opens sign-in and never Apple's sheet", async () => {
    const h = await signInCapable();
    h.host.props([]).native.onBuy?.();
    await h.settle();
    expect(h.deps.signIn).toHaveBeenCalledOnce();
    expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
    expect(h.host.signInForPurchase).toBe(true);
    expect(h.host.props([]).purchase.state).toBe("idle");
  });
  it("cancelling that sign-in opens no Apple sheet, and a later sign-in buys nothing", async () => {
    const h = await signInCapable();
    h.host.props([]).native.onBuy?.();
    await h.settle();
    h.host.signInDismissed();
    expect(h.host.signInForPurchase).toBe(false);
    h.setAccount(user);
    await h.settle();
    expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
    expect(h.host.props([]).purchase.state).toBe("idle");
  });
  it("a successful sign-in continues to Apple's sheet without a second tap and links to that account", async () => {
    const h = await signInCapable();
    h.host.props([]).native.onBuy?.();
    await h.settle();
    // Signed in but not yet confirmed: still waiting, nothing charged.
    h.setAccount({ ...user, confirmed: false });
    await h.settle();
    expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
    h.setAccount(user);
    await vi.waitFor(() => expect(h.deps.linkPurchase).toHaveBeenCalledOnce());
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce();
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledWith(offer);
    expect(h.deps.verifyLocalPurchase).toHaveBeenCalledOnce();
    expect(h.deps.signIn).toHaveBeenCalledOnce();
    expect(h.host.signInForPurchase).toBe(false);
    expect(h.host.props([]).purchase).toEqual({ state: "success", confirmed: true });
    expect(h.deps.linkPurchase).toHaveBeenCalledWith({
      intendedAccountId: user.id,
      expectedOwnershipRevision: 0,
      operationId: "00000000-0000-4000-8000-000000000001",
    });
    await h.settle();
    expect(h.host.settings().link).toEqual({ state: "linked", email: user.email });
  });
  it("an account update while the continued purchase is still checking re-arms it instead of losing it", async () => {
    const h = await signInCapable();
    h.host.props([]).native.onBuy?.();
    await h.settle();
    let release!: (value: BenefitAccessSnapshot) => void;
    vi.mocked(h.deps.readAccess).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    h.setAccount(user);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    // The session settles: a new revision, briefly unconfirmed, then confirmed again.
    h.setAccount({ ...user, revision: 2, confirmed: false });
    expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
    h.setAccount({ ...user, revision: 2 });
    release(access("locked"));
    await vi.waitFor(() => expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce());
    await h.settle();
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce();
    expect(h.host.props([]).purchase).toEqual({ state: "success", confirmed: true });
  });
  it("Buy without an account goes straight to Apple's sheet and links nothing", async () => {
    const h = await signInCapable();
    h.host.props([]).native.onBuy?.();
    await h.settle();
    h.host.buyWithoutAccount();
    await h.settle();
    expect(h.host.signInForPurchase).toBe(false);
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce();
    expect(h.host.props([]).purchase).toEqual({ state: "success", confirmed: true });
    expect(h.deps.signIn).toHaveBeenCalledOnce();
    // Signing in afterwards neither buys again nor links on its own.
    h.setAccount(user);
    await h.settle();
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce();
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("Buy without an account is inert unless Get Still Pro asked for sign-in", async () => {
    const h = await signInCapable();
    h.host.buyWithoutAccount();
    await h.settle();
    expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
  });
  it("already signed in, there is no sign-in step and the purchase links to the account", async () => {
    const h = await signInCapable();
    h.setAccount(user);
    await h.settle();
    h.host.props([]).native.onBuy?.();
    await vi.waitFor(() => expect(h.deps.linkPurchase).toHaveBeenCalledOnce());
    expect(h.deps.signIn).not.toHaveBeenCalled();
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce();
    expect(h.deps.linkPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ intendedAccountId: user.id, expectedOwnershipRevision: 0 }),
    );
  });
  it("an account switch while Apple's sheet is open never links, and Still Pro stays on this device", async () => {
    const h = await signInCapable();
    h.setAccount(user);
    await h.settle();
    let finish!: (value: NativeProResult) => void;
    vi.mocked(h.deps.bridge.purchasePro).mockImplementation(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    h.host.props([]).native.onBuy?.();
    await vi.waitFor(() => expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce());
    h.setAccount(other);
    finish(owned);
    await h.settle();
    await h.host.refresh();
    await h.settle();
    expect(h.host.props([]).access.state).toBe("owned");
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
    expect(h.host.settings().link).toBeUndefined();
  });
  it("signing out during verification never links", async () => {
    const h = await signInCapable();
    h.setAccount(user);
    await h.settle();
    let verified!: (value: BenefitAccessSnapshot) => void;
    vi.mocked(h.deps.verifyLocalPurchase).mockImplementationOnce(
      () => new Promise((resolve) => { verified = resolve; }),
    );
    h.host.props([]).native.onBuy?.();
    await vi.waitFor(() => expect(h.deps.verifyLocalPurchase).toHaveBeenCalledOnce());
    h.setAccount(null);
    verified(access("purchased"));
    await h.settle();
    await h.host.refresh();
    await h.settle();
    expect(h.host.props([]).access.state).toBe("owned");
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("a purchaser the device cannot prove is never linked; the failed card offers Try again", async () => {
    const h = await signInCapable();
    h.setAccount(user);
    await h.settle();
    vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue(null);
    h.host.props([]).native.onBuy?.();
    await vi.waitFor(() => expect(h.host.settings().link?.state).toBe("failed"));
    expect(h.host.props([]).purchase).toEqual({ state: "success", confirmed: true });
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
    // Try again re-runs the same guarded link once the purchaser can be proved.
    vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 0 });
    h.host.settings().link?.onRetry?.();
    await vi.waitFor(() => expect(h.host.settings().link?.state).toBe("linked"));
    expect(h.deps.linkPurchase).toHaveBeenCalledOnce();
  });
  it("an overlapping access refresh during the automatic link cannot silently drop it", async () => {
    const h = await signInCapable();
    h.setAccount(user);
    await h.settle();
    const reads: Array<(value: { ownershipRevision: number } | null) => void> = [];
    vi.mocked(h.deps.readLinkEligibility!).mockImplementation(
      () => new Promise((resolve) => { reads.push(resolve); }),
    );
    h.host.props([]).native.onBuy?.();
    await vi.waitFor(() => expect(reads.length).toBe(1));
    // An app return or still:accountAccess republishes access while the link reads eligibility.
    h.host.observeAccess(access("purchased"));
    await vi.waitFor(() => expect(reads.length).toBe(2));
    reads[1]!(null);
    await h.settle();
    reads[0]!({ ownershipRevision: 0 });
    await h.settle();
    for (const read of reads.slice(2)) read({ ownershipRevision: 0 });
    vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 0 });
    await h.settle();
    await vi.waitFor(() => expect(h.host.settings().link?.state).toMatch(/linked|failed/));
    expect(h.host.settings().link).toBeDefined();
  });
  it("signed in without an address yet, Get Still Pro is never a dead button", async () => {
    const h = await signInCapable();
    h.deps.signedIn = () => true;
    h.host.props([]).native.onBuy?.();
    await h.settle();
    expect(h.deps.signIn).not.toHaveBeenCalled();
    expect(h.host.signInForPurchase).toBe(false);
    expect(h.deps.bridge.purchasePro).toHaveBeenCalledOnce();
  });
  it("a sign-out during the continued check drops the continuation", async () => {
    const h = await signInCapable();
    h.host.props([]).native.onBuy?.();
    await h.settle();
    let release!: (value: BenefitAccessSnapshot) => void;
    vi.mocked(h.deps.readAccess).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    h.setAccount(user);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    h.setAccount(null);
    expect(h.host.signInForPurchase).toBe(false);
    release(access("locked"));
    await h.settle();
    h.setAccount(user);
    await h.settle();
    expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
  });
  it("a switch to another account during the continued check opens no sheet and links nothing", async () => {
    const h = await signInCapable();
    h.host.props([]).native.onBuy?.();
    await h.settle();
    let release!: (value: BenefitAccessSnapshot) => void;
    vi.mocked(h.deps.readAccess).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    h.setAccount(user);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    h.setAccount(other);
    release(access("locked"));
    await h.settle();
    expect(h.host.signInForPurchase).toBe(false);
    expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("the continuation is re-armed at most once", async () => {
    const h = await signInCapable();
    h.host.props([]).native.onBuy?.();
    await h.settle();
    vi.mocked(h.deps.readAccess).mockImplementation(() => new Promise(() => {}));
    h.setAccount(user);
    await h.settle();
    h.setAccount({ ...user, revision: 2 }); // first update: re-armed and continued again
    await h.settle();
    h.setAccount({ ...user, revision: 3 }); // second update: dropped
    await h.settle();
    expect(h.host.signInForPurchase).toBe(false);
    // The harness's first read, the continued purchase, and its one re-armed retry.
    expect(vi.mocked(h.deps.readAccess).mock.calls.length).toBe(3);
    expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
  });
  it("a failed link keeps Still Pro on this device and offers Try again", async () => {
    const h = await signInCapable();
    vi.mocked(h.deps.linkPurchase).mockResolvedValue({ status: "unavailable" });
    h.setAccount(user);
    await h.settle();
    h.host.props([]).native.onBuy?.();
    await vi.waitFor(() => expect(h.host.settings().link?.state).toBe("failed"));
    expect(h.host.settings().link?.onRetry).toBeTypeOf("function");
    expect(h.host.props([]).access.state).toBe("owned");
    expect(h.host.props([]).purchase).toEqual({ state: "success", confirmed: true });
  });
  it("Restore works signed out and never asks for sign-in", async () => {
    const h = await signInCapable();
    h.host.props([]).native.onRestore?.();
    await h.settle();
    expect(h.host.settings().restore?.state).toBe("restored");
    expect(h.deps.signIn).not.toHaveBeenCalled();
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("leaving the Still Pro screen drops the purchase sign-in, so a later sign-in buys nothing", async () => {
    const h = await signInCapable();
    h.host.show();
    h.host.props([]).native.onBuy?.();
    await h.settle();
    h.host.close();
    expect(h.host.signInForPurchase).toBe(false);
    h.setAccount(user);
    await h.settle();
    expect(h.deps.bridge.purchasePro).not.toHaveBeenCalled();
  });
});
// ISS-0076: an accountless holder who taps Sign in on the invitation must end at the link
// confirmation. Sign-in itself starts access re-checks (the account reconcile, the cache's minute
// refresh, each one re-reading link eligibility), and the request has to survive all of them.
describe("a requested link survives the re-checks that sign-in starts (ISS-0076)", () => {
  async function owned() {
    const h = await harness();
    h.host.props([]).native.onBuy?.();
    await h.settle();
    expect(h.host.props([]).access.state).toBe("owned");
    expect(h.host.canLink).toBe(true);
    return h;
  }
  it("a held access snapshot during sign-in does not drop the request; owned access brings the confirmation", async () => {
    const { host, deps, settle, setAccount } = await owned();
    await host.requestLink();
    expect(deps.signIn).toHaveBeenCalledOnce();
    // The entitlement cache holds the rows while a refresh is in flight, then publishes the read.
    host.observeAccess(access("verification_required"));
    await settle();
    host.observeAccess(access("purchased"));
    await settle();
    setAccount(user);
    await settle();
    expect(host.settings().link?.state).toBe("confirm");
    expect(host.settings().link?.email).toBe(user.email);
    expect(deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("a hold that lands after the account confirmed still ends in the confirmation once access is owned again", async () => {
    const { host, deps, settle, setAccount } = await owned();
    await host.requestLink();
    setAccount(user);
    await settle();
    expect(host.settings().link?.state).toBe("confirm");
    host.observeAccess(access("verification_required"));
    await settle();
    host.observeAccess(access("purchased"));
    await settle();
    expect(host.settings().link?.state).toBe("confirm");
    expect(deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("an eligibility re-read still in flight when the account confirms does not lose the request", async () => {
    const { host, deps, settle, setAccount } = await owned();
    await host.requestLink();
    expect(deps.signIn).toHaveBeenCalledOnce();
    let finish!: (value: { ownershipRevision: number }) => void;
    vi.mocked(deps.readLinkEligibility!).mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    // The reconcile sign-in starts publishes a fresh owned snapshot; its eligibility read is slow.
    host.observeAccess(access("purchased"));
    await settle();
    setAccount(user);
    await settle();
    expect(deps.linkPurchase).not.toHaveBeenCalled();
    finish({ ownershipRevision: 0 });
    await settle();
    expect(host.settings().link?.state).toBe("confirm");
    expect(host.settings().link?.email).toBe(user.email);
  });
  it("a fresh snapshot while linking is requested keeps the link affordance instead of blinking it off", async () => {
    const { host, deps, settle } = await owned();
    let finish!: (value: { ownershipRevision: number }) => void;
    vi.mocked(deps.readLinkEligibility!).mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    host.observeAccess(access("purchased"));
    await settle();
    expect(host.canLink).toBe(true);
    finish({ ownershipRevision: 0 });
    await settle();
    expect(host.canLink).toBe(true);
  });
  it("a refused eligibility read during sign-in (native busy reconciling) does not drop the request", async () => {
    const { host, deps, settle, setAccount } = await owned();
    await host.requestLink();
    expect(deps.signIn).toHaveBeenCalledOnce();
    // The reconcile sign-in starts republishes access; native refuses the overlapping read once.
    vi.mocked(deps.readLinkEligibility!).mockRejectedValueOnce(new Error("Apple link eligibility requires verification"));
    host.observeAccess(access("purchased"));
    await settle();
    expect(host.canLink).toBe(true);
    setAccount(user);
    await settle();
    expect(host.settings().link?.state).toBe("confirm");
    expect(host.settings().link?.email).toBe(user.email);
    expect(deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("a refused read after the account confirmed still ends in the confirmation on the next settled read", async () => {
    const { host, deps, settle, setAccount } = await owned();
    await host.requestLink();
    vi.mocked(deps.readLinkEligibility!)
      .mockRejectedValueOnce(new Error("requires verification"))
      .mockRejectedValueOnce(new Error("requires verification"));
    setAccount(user);
    await settle();
    host.observeAccess(access("purchased"));
    await settle();
    expect(host.settings().link?.state).toBe("confirm");
  });
  it("a settled not-eligible answer still drops the request and the affordance", async () => {
    const { host, deps, settle, setAccount } = await owned();
    await host.requestLink();
    vi.mocked(deps.readLinkEligibility!).mockResolvedValue(null);
    host.observeAccess(access("purchased"));
    await settle();
    expect(host.canLink).toBe(false);
    setAccount(user);
    await settle();
    expect(host.settings().link).toBeUndefined();
  });
  it("conclusively locked access drops the request: a later sign-in offers nothing", async () => {
    const { host, deps, settle, setAccount } = await owned();
    await host.requestLink();
    host.observeAccess(access("locked"));
    await settle();
    setAccount(user);
    await settle();
    expect(host.settings().link).toBeUndefined();
    expect(host.canLink).toBe(false);
    expect(deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("closing the sign-in sheet signed out drops the request: a later sign-in shows no confirmation", async () => {
    const { host, deps, settle, setAccount } = await owned();
    await host.requestLink();
    expect(deps.signIn).toHaveBeenCalledOnce();
    host.signInDismissed();
    setAccount(user);
    await settle();
    expect(host.settings().link).toBeUndefined();
    expect(host.canLink).toBe(true);
    expect(deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("nothing links without the confirmation tap, and the tap links exactly once", async () => {
    const { host, deps, settle, setAccount } = await owned();
    await host.requestLink();
    host.observeAccess(access("verification_required"));
    host.observeAccess(access("purchased"));
    await settle();
    setAccount(user);
    await settle();
    expect(host.settings().link?.state).toBe("confirm");
    expect(deps.linkPurchase).not.toHaveBeenCalled();
    host.settings().link?.onConfirm?.();
    await settle();
    expect(deps.linkPurchase).toHaveBeenCalledOnce();
    expect(host.settings().link?.state).toBe("linked");
  });
  it("confirming during a held snapshot reports a failure with Try again instead of doing nothing", async () => {
    const { host, deps, settle, setAccount } = await owned();
    setAccount(user);
    await host.requestLink();
    expect(host.settings().link?.state).toBe("confirm");
    host.observeAccess(access("verification_required"));
    host.settings().link?.onConfirm?.();
    await settle();
    expect(deps.linkPurchase).not.toHaveBeenCalled();
    expect(host.settings().link?.state).toBe("failed");
    host.observeAccess(access("purchased"));
    await settle();
    host.settings().link?.onRetry?.();
    await settle();
    expect(host.settings().link?.state).toBe("confirm");
  });
});
// ISS-0104: on 2.1.1.400 an iPhone whose Apple Still Pro was linked to one account, signed in as
// another, offered Link and then showed "Linking didn't finish" with Try again for the server's
// deliberate refusal (owned_elsewhere: a right moves only with its holder's own sign-in). Native
// never holds another account's proof, so the refusal is the signal; it is remembered for that
// account at that purchaser revision, the card states the fact, and nothing is offered.
describe("a right linked to a different account is stated, not offered (ISS-0104)", () => {
  const stranger = { ...user, id: "00000000-0000-4000-8000-000000000004", email: "stranger@still.test" };
  async function refused() {
    const h = await harness();
    vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 1, linkedAccount: null });
    vi.mocked(h.deps.linkPurchase).mockResolvedValue({ status: "owned_elsewhere" });
    h.setAccount(user);
    h.host.observeAccess(access("purchased"));
    await h.settle();
    expect(h.host.canLink).toBe(true);
    await h.host.requestLink();
    expect(h.host.settings().link?.state).toBe("confirm");
    h.host.settings().link?.onConfirm?.();
    await h.settle();
    return h;
  }
  it("the server's owned_elsewhere becomes the fact, without Try again, and the offer is withdrawn", async () => {
    const { host, deps, settle } = await refused();
    expect(deps.linkPurchase).toHaveBeenCalledOnce();
    expect(host.settings().link).toEqual({ state: "elsewhere", email: user.email });
    expect(host.settings().link).not.toHaveProperty("onRetry");
    expect(host.canLink).toBe(false);
    expect(host.props([]).access.state).toBe("owned");
    // A stray request asks the server nothing more.
    await host.requestLink();
    await settle();
    expect(deps.linkPurchase).toHaveBeenCalledOnce();
    expect(host.settings().link?.state).toBe("elsewhere");
  });
  it("remembered per account: signing out clears the card, the same account gets it back, another account gets the offer", async () => {
    const { host, deps, settle, setAccount } = await refused();
    setAccount(null);
    host.observeAccess(access("purchased"));
    await settle();
    expect(host.settings().link).toBeUndefined();
    setAccount(user);
    host.observeAccess(access("purchased"));
    await settle();
    expect(host.settings().link).toEqual({ state: "elsewhere", email: user.email });
    expect(host.canLink).toBe(false);
    setAccount(stranger);
    host.observeAccess(access("purchased"));
    await settle();
    expect(host.settings().link?.state).not.toBe("elsewhere");
    expect(host.canLink).toBe(true);
    expect(deps.linkPurchase).toHaveBeenCalledOnce();
  });
  it("a new purchaser revision (the holder moved it) ends the memory, and a proof naming this account says linked", async () => {
    const h = await refused();
    vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 2, linkedAccount: null });
    h.host.observeAccess(access("purchased"));
    await h.settle();
    expect(h.host.settings().link).toBeUndefined();
    expect(h.host.canLink).toBe(true);
    vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 2, linkedAccount: user.id });
    h.host.observeAccess(access("purchased"));
    await h.settle();
    expect(h.host.canLink).toBe(false);
    expect(h.host.settings().link?.state).not.toBe("elsewhere");
  });
  it("a proof naming this account at the remembered revision wins over the memory: linked, not elsewhere", async () => {
    const h = await refused();
    vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 1, linkedAccount: user.id });
    h.host.observeAccess(access("purchased"));
    await h.settle();
    expect(h.host.settings().link?.state).not.toBe("elsewhere");
    expect(h.host.canLink).toBe(false);
    await h.host.requestLink();
    await h.settle();
    expect(h.deps.linkPurchase).toHaveBeenCalledOnce();
    expect(h.host.settings().link?.state).not.toBe("elsewhere");
  });
  it("a session revision bump for the same account keeps the card; a different address does not", async () => {
    const h = await refused();
    h.setAccount({ ...user, revision: user.revision + 1 });
    expect(h.host.settings().link).toEqual({ state: "elsewhere", email: user.email });
    expect(h.host.canLink).toBe(false);
    h.host.observeAccess(access("purchased"));
    await h.settle();
    expect(h.host.settings().link).toEqual({ state: "elsewhere", email: user.email });
    h.setAccount({ ...user, revision: user.revision + 2, email: "renamed@still.test" });
    expect(h.host.settings().link).not.toEqual({ state: "elsewhere", email: user.email });
  });
  describe("the memory outlives the host", () => {
    const memory = () => {
      let value: string | null = null;
      return {
        read: vi.fn(() => value),
        write: vi.fn((next: string) => {
          value = next;
        }),
      };
    };
    async function refusedWith(store: ReturnType<typeof memory>) {
      const h = await harness({ heldElsewhereMemory: store });
      vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 1, linkedAccount: null });
      vi.mocked(h.deps.linkPurchase).mockResolvedValue({ status: "owned_elsewhere" });
      h.setAccount(user);
      h.host.observeAccess(access("purchased"));
      await h.settle();
      await h.host.requestLink();
      h.host.settings().link?.onConfirm?.();
      await h.settle();
      expect(h.host.settings().link?.state).toBe("elsewhere");
      return h;
    }
    it("a relaunch states the fact for the same account at the same revision, and asks the server nothing", async () => {
      const store = memory();
      await refusedWith(store);
      expect(store.write).toHaveBeenCalledWith(JSON.stringify({ [user.id]: 1 }));
      const again = await harness({ heldElsewhereMemory: store });
      vi.mocked(again.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 1, linkedAccount: null });
      again.setAccount(user);
      again.host.observeAccess(access("purchased"));
      await again.settle();
      expect(again.host.settings().link).toEqual({ state: "elsewhere", email: user.email });
      expect(again.host.canLink).toBe(false);
      await again.host.requestLink();
      await again.settle();
      expect(again.deps.linkPurchase).not.toHaveBeenCalled();
    });
    it("remembers each refused account; a later launch offers the holder's move (new revision) again", async () => {
      const store = memory();
      const h = await refusedWith(store);
      h.setAccount(stranger);
      h.host.observeAccess(access("purchased"));
      await h.settle();
      await h.host.requestLink();
      h.host.settings().link?.onConfirm?.();
      await h.settle();
      expect(h.host.settings().link).toEqual({ state: "elsewhere", email: stranger.email });
      expect(JSON.parse(store.write.mock.calls.at(-1)![0])).toEqual({ [user.id]: 1, [stranger.id]: 1 });
      const again = await harness({ heldElsewhereMemory: store });
      vi.mocked(again.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 2, linkedAccount: null });
      again.setAccount(user);
      again.host.observeAccess(access("purchased"));
      await again.settle();
      expect(again.host.settings().link).toBeUndefined();
      expect(again.host.canLink).toBe(true);
    });
    it.each([
      ["a thrown read", () => { throw new Error("storage refused"); }],
      ["a null read", () => null],
      ["non-JSON", () => "{not json"],
      ["a non-object", () => "[1,2]"],
      ["non-number revisions", () => JSON.stringify({ [user.id]: "1" })],
    ])("%s is empty memory: the offer shows as usual and a refusal is still remembered", async (_name, read) => {
      const store = { read: vi.fn(read), write: vi.fn() };
      const h = await harness({ heldElsewhereMemory: store });
      vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 1, linkedAccount: null });
      vi.mocked(h.deps.linkPurchase).mockResolvedValue({ status: "owned_elsewhere" });
      h.setAccount(user);
      h.host.observeAccess(access("purchased"));
      await h.settle();
      expect(h.host.canLink).toBe(true);
      await h.host.requestLink();
      expect(h.host.settings().link?.state).toBe("confirm");
      h.host.settings().link?.onConfirm?.();
      await h.settle();
      expect(h.host.settings().link).toEqual({ state: "elsewhere", email: user.email });
      expect(store.write).toHaveBeenCalledWith(JSON.stringify({ [user.id]: 1 }));
    });
    it("an answer that disproves the memory drops that account's entry: a proof naming it, or a link that went through", async () => {
      const store = memory();
      const h = await refusedWith(store);
      // Native's proof now names this account (the holder moved it to them): the entry goes.
      vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 1, linkedAccount: user.id });
      h.host.observeAccess(access("purchased"));
      await h.settle();
      expect(h.host.settings().link?.state).not.toBe("elsewhere");
      expect(JSON.parse(store.write.mock.calls.at(-1)![0])).toEqual({});
      // Another account refused, then linked on a later revision: only the refused one stays.
      vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 2, linkedAccount: null });
      h.setAccount(stranger);
      h.host.observeAccess(access("purchased"));
      await h.settle();
      await h.host.requestLink();
      h.host.settings().link?.onConfirm?.();
      await h.settle();
      expect(JSON.parse(store.write.mock.calls.at(-1)![0])).toEqual({ [stranger.id]: 2 });
      vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 3, linkedAccount: null });
      vi.mocked(h.deps.linkPurchase).mockResolvedValue({ status: "linked", ownershipRevision: 4 });
      h.host.observeAccess(access("purchased"));
      await h.settle();
      await h.host.requestLink();
      h.host.settings().link?.onConfirm?.();
      await h.settle();
      expect(h.host.settings().link).toEqual({ state: "linked", email: stranger.email });
      expect(JSON.parse(store.write.mock.calls.at(-1)![0])).toEqual({});
    });
    it("a refused write keeps the fact for this launch", async () => {
      const store = { read: vi.fn(() => null), write: vi.fn(() => { throw new Error("quota"); }) };
      const h = await harness({ heldElsewhereMemory: store });
      vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 1, linkedAccount: null });
      vi.mocked(h.deps.linkPurchase).mockResolvedValue({ status: "owned_elsewhere" });
      h.setAccount(user);
      h.host.observeAccess(access("purchased"));
      await h.settle();
      await h.host.requestLink();
      h.host.settings().link?.onConfirm?.();
      await h.settle();
      expect(h.host.settings().link).toEqual({ state: "elsewhere", email: user.email });
      h.host.observeAccess(access("purchased"));
      await h.settle();
      expect(h.host.settings().link).toEqual({ state: "elsewhere", email: user.email });
      expect(h.host.canLink).toBe(false);
    });
  });
});

// ISS-0081: on 2.1.1.387 and .392 a Mac that had linked an accountless Apple Still Pro to the
// signed-in account offered "Link Still Pro to your account." again on every launch: the link read
// said "can link" for a right the server had already linked. Native now names the account its
// current server-signed account proof links the right to, and the host offers nothing for it.
describe("a right already linked to the signed-in account is not offered again (ISS-0081)", () => {
  const other = "00000000-0000-4000-8000-000000000003";
  async function launch(linkedAccount: string | null, signedIn: AppleProAccount | null = user) {
    const h = await harness();
    vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 1, linkedAccount });
    h.setAccount(signedIn);
    h.host.observeAccess(access("purchased"));
    await h.settle();
    expect(h.host.props([]).access.state).toBe("owned");
    return h;
  }
  it("linked to the signed-in account: no offer, no card, and a stray request links nothing", async () => {
    const { host, deps, settle } = await launch(user.id);
    expect(host.canLink).toBe(false);
    expect(host.settings().link).toBeUndefined();
    await host.requestLink();
    await settle();
    expect(deps.linkPurchase).not.toHaveBeenCalled();
    expect(deps.signIn).not.toHaveBeenCalled();
    expect(host.settings().link?.state).not.toBe("confirm");
  });
  it("linked to another account (native names it): no offer, the card says so, a stray request asks no server (ISS-0104)", async () => {
    const { host, deps, settle } = await launch(other);
    expect(host.canLink).toBe(false);
    expect(host.settings().link).toEqual({ state: "elsewhere", email: user.email });
    await host.requestLink();
    await settle();
    expect(deps.linkPurchase).not.toHaveBeenCalled();
    expect(host.settings().link?.state).toBe("elsewhere");
  });
  it("accountless right, signed in: the offer shows", async () => {
    const { host } = await launch(null);
    expect(host.canLink).toBe(true);
  });
  it("signed out: the invitation stays, whatever native names", async () => {
    const { host } = await launch(user.id, null);
    expect(host.canLink).toBe(true);
  });
  it("a proof that arrives only after the first read following sign-in turns the confirmation into linked", async () => {
    const h = await harness();
    vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 1, linkedAccount: null });
    h.host.observeAccess(access("purchased"));
    await h.settle();
    await h.host.requestLink();
    // A brand-new session: native holds no account proof yet when the request re-reads.
    h.setAccount(user);
    await h.settle();
    expect(h.host.settings().link?.state).toBe("confirm");
    const staleConfirm = h.host.settings().link?.onConfirm;
    // The sign-in's reconcile installs the proof and republishes access.
    vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 1, linkedAccount: user.id });
    h.host.observeAccess(access("purchased"));
    await h.settle();
    expect(h.host.settings().link).toEqual({ state: "linked", email: user.email });
    expect(h.host.canLink).toBe(false);
    staleConfirm?.();
    await h.settle();
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
    expect(h.host.settings().link?.state).toBe("linked");
  });
  it("a confirmation for a right the read then says is linked elsewhere becomes the fact, and its stale tap links nothing (ISS-0104)", async () => {
    const h = await harness();
    h.setAccount(user);
    vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 1, linkedAccount: null });
    h.host.observeAccess(access("purchased"));
    await h.settle();
    await h.host.requestLink();
    expect(h.host.settings().link?.state).toBe("confirm");
    const staleConfirm = h.host.settings().link?.onConfirm;
    vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 1, linkedAccount: "00000000-0000-4000-8000-000000000003" });
    h.host.observeAccess(access("purchased"));
    await h.settle();
    expect(h.host.settings().link).toEqual({ state: "elsewhere", email: user.email });
    expect(h.host.canLink).toBe(false);
    staleConfirm?.();
    await h.settle();
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
    expect(h.host.settings().link?.state).toBe("elsewhere");
  });
  it("signing in from the invitation as the account it is linked to says it is linked, without asking again", async () => {
    const h = await harness();
    vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 1, linkedAccount: null });
    h.host.observeAccess(access("purchased"));
    await h.settle();
    await h.host.requestLink();
    expect(h.deps.signIn).toHaveBeenCalledOnce();
    // The sign-in's reconcile installs the account's proofs: native now names that account.
    vi.mocked(h.deps.readLinkEligibility!).mockResolvedValue({ ownershipRevision: 1, linkedAccount: user.id });
    h.setAccount(user);
    await h.settle();
    h.host.observeAccess(access("purchased"));
    await h.settle();
    expect(h.host.settings().link).toEqual({ state: "linked", email: user.email });
    expect(h.host.canLink).toBe(false);
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
    // Signing out drops the card; the invitation comes back for the signed-out holder.
    h.setAccount(null);
    await h.settle();
    expect(h.host.settings().link).toBeUndefined();
    expect(h.host.canLink).toBe(true);
  });
});
// ISS-0076, MAC-85 (Mac .383 to .387): an accountless holder taps Sign in on the invitation, enters
// the code, and lands signed in with the offer card instead of "Link Still Pro to this account?".
// These replay the sign-in the app really runs. The verified code first enters the session
// (AppleSession.enterSession: a new account revision, the address, and the settings mirror the code
// waits for) and only then returns to the controller, which advances the revision once more. Each
// revision re-reads the account's confirmation, so the account is confirmed at one revision,
// unconfirmed at the next, then confirmed again. Meanwhile the account reconcile republishes access
// (a re-check, then owned) and native may refuse the eligibility read while it runs.
describe("the MAC-85 sign-in from the invitation, in every order the Mac can produce (ISS-0076)", () => {
  const other = "00000000-0000-4000-8000-000000000009";
  const at = (revision: number, confirmed: boolean) => ({ ...user, revision, confirmed });
  async function holder(options: { heldElsewhere?: string } = {}) {
    let answer: { ownershipRevision: number; linkedAccount: string | null } | null = {
      ownershipRevision: 0,
      linkedAccount: null,
    };
    let refusing = 0;
    const readLinkEligibility = vi.fn(async () => {
      if (refusing > 0) {
        refusing--;
        throw new Error("still: Apple link eligibility requires verification");
      }
      return answer;
    });
    const reconciles: Array<(snapshot: BenefitAccessSnapshot) => void> = [];
    const refreshAccountAccess = vi.fn(
      () => new Promise<BenefitAccessSnapshot>((resolve) => reconciles.push(resolve)),
    );
    let memory = options.heldElsewhere ?? null;
    const h = await harness({
      readAccess: vi.fn(async () => access("purchased")),
      readLinkEligibility,
      refreshAccountAccess,
      canSignIn: () => true,
      heldElsewhereMemory: { read: () => memory, write: (value) => { memory = value; } },
    });
    expect(h.host.canLink).toBe(true);
    // The invitation's Sign in: the host records the request and opens sign-in.
    await h.host.requestLink();
    expect(h.deps.signIn).toHaveBeenCalledOnce();
    expect(h.host.settings().link).toBeUndefined();
    return {
      ...h,
      refuse(n: number) { refusing = n; },
      answer(next: typeof answer) { answer = next; },
      /** The reconcile publishes a re-check and then owned access, and finishes. */
      async republish() {
        h.host.observeAccess(access("checking"));
        await h.settle();
        h.host.observeAccess(access("purchased"));
        await h.settle();
      },
      async finishReconciles() {
        while (reconciles.length) reconciles.shift()!(access("purchased"));
        await h.settle();
      },
      /** enterSession's revision, confirmed, then the controller's own revision, confirmed. */
      async signIn() {
        h.setAccount(at(2, false));
        await h.settle();
        h.setAccount(at(2, true));
        await h.settle();
      },
      async controllerRevision() {
        h.setAccount(at(3, false));
        await h.settle();
        h.setAccount(at(3, true));
        await h.settle();
      },
      async linksOnConfirm() {
        expect(h.host.settings().link?.state).toBe("confirm");
        expect(h.host.settings().link?.email).toBe(user.email);
        expect(h.deps.linkPurchase).not.toHaveBeenCalled();
        h.host.settings().link?.onConfirm?.();
        await h.settle();
        expect(h.deps.linkPurchase).toHaveBeenCalledOnce();
        expect(h.deps.linkPurchase).toHaveBeenCalledWith(
          expect.objectContaining({ intendedAccountId: user.id, expectedOwnershipRevision: 0 }),
        );
        expect(h.host.settings().link?.state).toBe("linked");
      },
    };
  }
  it("the code's two account revisions: confirmed at the session's, then the controller's own", async () => {
    const h = await holder();
    await h.signIn();
    expect(h.host.settings().link?.state).toBe("confirm");
    await h.controllerRevision();
    await h.republish();
    await h.finishReconciles();
    await h.linksOnConfirm();
  });
  it("the controller's revision lands while the reconcile is still republishing access", async () => {
    const h = await holder();
    await h.signIn();
    h.host.observeAccess(access("checking"));
    await h.settle();
    await h.controllerRevision();
    h.host.observeAccess(access("purchased"));
    await h.settle();
    await h.finishReconciles();
    await h.linksOnConfirm();
  });
  it("one account revision only (the address already known): the confirmation", async () => {
    const h = await holder();
    await h.signIn();
    await h.republish();
    await h.finishReconciles();
    await h.linksOnConfirm();
  });
  it("native refuses the request's read when the account confirms (before the owned snapshot)", async () => {
    const h = await holder();
    h.refuse(1);
    await h.signIn();
    await h.republish();
    await h.finishReconciles();
    await h.controllerRevision();
    await h.finishReconciles();
    await h.linksOnConfirm();
  });
  it("native refuses every read while the reconcile runs, then answers", async () => {
    const h = await holder();
    h.refuse(Number.POSITIVE_INFINITY);
    await h.signIn();
    await h.republish();
    h.refuse(0);
    await h.finishReconciles();
    await h.controllerRevision();
    await h.finishReconciles();
    await h.linksOnConfirm();
  });
  it("native refuses every read until after the reconcile and the controller's revision: the confirmation from the last answer", async () => {
    const h = await holder();
    h.refuse(Number.POSITIVE_INFINITY);
    await h.signIn();
    await h.republish();
    await h.finishReconciles();
    await h.controllerRevision();
    await h.finishReconciles();
    expect(h.host.canLink).toBe(false);
    h.refuse(0);
    await h.linksOnConfirm();
  });
  it("a re-check overtakes the request's own read, and native refuses every read after it (one revision, no bump)", async () => {
    const h = await holder();
    let finish!: (value: { ownershipRevision: number; linkedAccount: null }) => void;
    vi.mocked(h.deps.readLinkEligibility!).mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    h.setAccount(at(2, true));
    await h.settle();
    // The request's read is still out when the reconcile republishes a re-check: it is overtaken.
    h.host.observeAccess(access("checking"));
    await h.settle();
    finish({ ownershipRevision: 0, linkedAccount: null });
    await h.settle();
    h.refuse(Number.POSITIVE_INFINITY);
    h.host.observeAccess(access("purchased"));
    await h.settle();
    await h.finishReconciles();
    // Only refused reads follow, and no account change comes to re-offer it: the refused read itself
    // must offer the request from the last settled answer (which keeps the affordance on), not the
    // offer card. Native answers again by the time the person taps Link.
    expect(h.host.canLink).toBe(false);
    h.refuse(0);
    await h.linksOnConfirm();
  });
  it("the access republish lands before the account does", async () => {
    const h = await holder();
    await h.republish();
    h.refuse(2);
    await h.signIn();
    await h.controllerRevision();
    await h.finishReconciles();
    await h.linksOnConfirm();
  });
  it("native names the signed-in account (ISS-0081): linked, nothing offered, across the controller's revision", async () => {
    const h = await holder();
    h.answer({ ownershipRevision: 0, linkedAccount: user.id });
    await h.signIn();
    expect(h.host.settings().link).toEqual({ state: "linked", email: user.email });
    h.setAccount(at(3, false));
    await h.settle();
    expect(h.host.settings().link).toEqual({ state: "linked", email: user.email });
    h.setAccount(at(3, true));
    await h.settle();
    await h.republish();
    await h.finishReconciles();
    expect(h.host.settings().link).toEqual({ state: "linked", email: user.email });
    expect(h.host.canLink).toBe(false);
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("native names another account (ISS-0104): the elsewhere card, nothing offered", async () => {
    const h = await holder();
    h.answer({ ownershipRevision: 0, linkedAccount: other });
    await h.signIn();
    await h.controllerRevision();
    await h.republish();
    await h.finishReconciles();
    expect(h.host.settings().link).toEqual({ state: "elsewhere", email: user.email });
    expect(h.host.canLink).toBe(false);
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("a remembered owned_elsewhere for this account at an older revision does not hide the confirmation", async () => {
    const h = await holder({ heldElsewhere: JSON.stringify({ [user.id]: 7 }) });
    await h.signIn();
    await h.controllerRevision();
    await h.republish();
    await h.finishReconciles();
    await h.linksOnConfirm();
  });
  it("a remembered owned_elsewhere for this account at this revision states the fact instead (by design)", async () => {
    const h = await holder({ heldElsewhere: JSON.stringify({ [user.id]: 0 }) });
    await h.signIn();
    await h.controllerRevision();
    await h.republish();
    await h.finishReconciles();
    expect(h.host.settings().link).toEqual({ state: "elsewhere", email: user.email });
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("a session revision bump much later for the same account still ends in the confirmation", async () => {
    const h = await holder();
    await h.signIn();
    await h.controllerRevision();
    await h.republish();
    await h.finishReconciles();
    h.setAccount(at(4, false));
    await h.settle();
    h.setAccount(at(4, true));
    await h.settle();
    await h.finishReconciles();
    await h.linksOnConfirm();
  });
  it("signing in as someone else in between still drops the request", async () => {
    const h = await holder();
    await h.signIn();
    expect(h.host.settings().link?.state).toBe("confirm");
    h.setAccount({ ...user, id: other, email: "other@still.test", revision: 3, confirmed: true });
    await h.settle();
    await h.finishReconciles();
    expect(h.host.settings().link).toBeUndefined();
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("between the two revisions the early card stays without buttons: no offer, no second sign-in", async () => {
    const h = await holder();
    await h.signIn();
    const early = h.host.settings().link;
    expect(early?.state).toBe("confirm");
    h.setAccount(at(3, false));
    await h.settle();
    // The gap may last (the confirmation read at the new revision can fail): it holds the place.
    expect(h.host.settings().link).toEqual({ state: "confirm", email: user.email });
    expect(h.host.canLink).toBe(false);
    early?.onConfirm?.();
    early?.onChooseOther?.();
    await h.republish();
    await h.finishReconciles();
    expect(h.host.settings().link).toEqual({ state: "confirm", email: user.email });
    expect(h.host.canLink).toBe(false);
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
    expect(h.deps.chooseOtherAccount).not.toHaveBeenCalled();
    expect(h.deps.signIn).toHaveBeenCalledOnce();
    h.setAccount(at(3, true));
    await h.settle();
    await h.finishReconciles();
    await h.linksOnConfirm();
    expect(h.deps.signIn).toHaveBeenCalledOnce();
  });
  it("a sign-out between the two revisions drops the request: the next account gets no confirmation", async () => {
    const h = await holder();
    await h.signIn();
    h.setAccount(at(3, false));
    await h.settle();
    h.setAccount(null);
    await h.settle();
    expect(h.host.settings().link).toBeUndefined();
    h.setAccount({ ...user, id: other, email: "other@still.test", revision: 5, confirmed: true });
    await h.settle();
    await h.finishReconciles();
    expect(h.host.settings().link).toBeUndefined();
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("another account while the new revision is unconfirmed drops the request", async () => {
    const h = await holder();
    await h.signIn();
    h.setAccount(at(3, false));
    await h.settle();
    h.setAccount({ ...user, id: other, email: "other@still.test", revision: 4, confirmed: true });
    await h.settle();
    await h.finishReconciles();
    expect(h.host.settings().link).toBeUndefined();
    expect(h.deps.linkPurchase).not.toHaveBeenCalled();
  });
  it("Link tapped on the early card, the controller's revision lands while it is in flight: linked or re-offered, never the offer card", async () => {
    const h = await holder();
    await h.signIn();
    let finish!: (value: { status: "linked"; ownershipRevision: number }) => void;
    vi.mocked(h.deps.linkPurchase).mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    h.host.settings().link?.onConfirm?.();
    await h.settle();
    expect(h.host.settings().link?.state).toBe("pending");
    await h.controllerRevision();
    finish({ status: "linked", ownershipRevision: 1 });
    await h.settle();
    await h.finishReconciles();
    expect(h.host.canLink).toBe(false);
    expect(h.host.settings().link?.state).toBe("confirm");
    // The server already holds the link; the fresh confirmation's Link hears already_linked.
    vi.mocked(h.deps.linkPurchase).mockResolvedValueOnce({ status: "already_linked", ownershipRevision: 1 });
    h.host.settings().link?.onConfirm?.();
    await h.settle();
    expect(h.deps.linkPurchase).toHaveBeenCalledTimes(2);
    expect(h.host.settings().link).toEqual({ state: "linked", email: user.email });
  });
});
