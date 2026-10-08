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
async function harness() {
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
    expect(host.props([]).purchase.state).toBe("failed");
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
      status: "owned_elsewhere",
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
  it("a same-account eligible observation during confirmation returns to recoverable consent", async () => {
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
    expect(host.settings().link?.state).toBe("failed");
    expect(deps.linkPurchase).not.toHaveBeenCalled();
    host.settings().link?.onRetry?.();
    await settle();
    expect(host.settings().link?.state).toBe("confirm");
    expect(deps.linkPurchase).not.toHaveBeenCalled();
    host.settings().link?.onConfirm?.();
    await settle();
    expect(deps.linkPurchase).toHaveBeenCalledOnce();
    expect(host.settings().link?.state).toBe("linked");
  });
  it.each(["verification_required", "purchased"] as const)(
    "a newer %s observation during the fresh offering read prevents a native charge",
    async (state) => {
      const { host, deps, settle } = await harness();
      let finish!: (value: NativeLifetimeOffering) => void;
      vi.mocked(deps.bridge.proOffering).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      host.props([]).native.onBuy?.();
      await settle();
      host.observeAccess(access(state));
      finish(offer);
      await settle();
      expect(deps.bridge.purchasePro).not.toHaveBeenCalled();
      expect(deps.verifyLocalPurchase).not.toHaveBeenCalled();
      expect(host.props([]).purchase.state).toBe("idle");
    },
  );
});

it("an offering-read observation change keeps a locked user able to retry a fresh acquisition", async () => {
  const { host, deps, settle } = await harness();
  let finish!: (value: NativeLifetimeOffering) => void;
  vi.mocked(deps.bridge.proOffering).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  host.props([]).native.onBuy?.();
  await settle();
  host.observeAccess(access("locked"));
  finish(offer);
  await settle();
  expect(deps.bridge.purchasePro).not.toHaveBeenCalled();
  expect(host.props([]).purchase.state).toBe("idle");
  host.props([]).native.onBuy?.();
  await settle();
  expect(deps.bridge.purchasePro).toHaveBeenCalledOnce();
  expect(host.props([]).purchase).toEqual({
    state: "success",
    confirmed: true,
  });
});
it("current accepted publication from the successful signed installer completes local fulfillment", async () => {
  const { host, deps, settle } = await harness();
  vi.mocked(deps.verifyLocalPurchase).mockImplementationOnce(async () => {
    const accepted = access("purchased");
    host.observeAccess(accepted);
    return accepted;
  });
  host.props([]).native.onBuy?.();
  await settle();
  expect(host.props([]).purchase).toEqual({
    state: "success",
    confirmed: true,
  });
  expect(deps.bridge.purchasePro).toHaveBeenCalledOnce();
});

it("settings exposes only pending verification and reopening never dispatches a new charge", async () => {
  const { host, deps, settle } = await harness();
  vi.mocked(deps.verifyLocalPurchase).mockRejectedValueOnce(
    new Error("Offline"),
  );
  host.props([]).native.onBuy?.();
  await settle();
  expect(host.settings().pro?.verificationRequired).toBe(true);
  host.close();
  const recover = host.show;
  recover();
  await settle();
  expect(deps.verifyLocalPurchase).toHaveBeenCalledTimes(2);
  expect(deps.bridge.purchasePro).toHaveBeenCalledOnce();
  expect(host.settings().pro?.verificationRequired).toBeUndefined();
  vi.mocked(deps.readAccess).mockResolvedValue(access("purchased"));
  host.close();
  recover();
  await settle();
  expect(deps.verifyLocalPurchase).toHaveBeenCalledTimes(2);
  expect(deps.bridge.purchasePro).toHaveBeenCalledOnce();
  expect(deps.linkPurchase).not.toHaveBeenCalled();
});


describe("Apple web-purchased account recovery", () => {
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
