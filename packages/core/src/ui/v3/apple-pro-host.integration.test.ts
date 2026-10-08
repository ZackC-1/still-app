import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/svelte";
vi.mock("@still/core/invitations/rating-hold", async (original) => ({
  ...(await original<typeof import("../../invitations/rating-hold.js")>()),
  reportRatingHold: vi.fn(),
}));
import { reportRatingHold } from "../../invitations/rating-hold.js";
import { resolve } from "node:path";
import type { Component } from "svelte";
vi.mock("@still/shared-types", async (original) => ({
  ...(await original<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));
import {
  DEFAULT_SETTINGS,
  FEATURE_REGISTRY,
  type BenefitAccessSnapshot,
} from "@still/shared-types";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { WKWebViewStorageAdapter } from "../../storage/wkwebview-adapter.js";
import { createApplePurchaseAuthority } from "../../native/apple-purchase-authority.js";
import { NativeBridge, type NativeProResult } from "../../native/bridge.js";
import {
  ACCESS_BENEFITS,
  initialAccessSnapshot,
} from "../../entitlement/access-policy.js";
import { UiController } from "../controller.svelte.js";
import {
  appleSettingsCacheOptions,
  createAppleSettingsAuthority,
} from "./apple-settings-host.js";

const HOST_PATH = resolve(
  import.meta.dirname,
  "../../../../app-webview/src/AppleSettingsHost.svelte",
);
const authorities: Array<ReturnType<typeof createAppleSettingsAuthority>> = [];
afterEach(() => {
  cleanup();
  authorities.splice(0).forEach((a) => a.stop());
});
function snapshot(
  state: "locked" | "purchased" | "protected" | "verification_required",
): BenefitAccessSnapshot {
  const value = initialAccessSnapshot({
    paidMode: true,
    supported: new Set(ACCESS_BENEFITS),
  });
  return {
    ...value,
    independentProtection:
      state === "protected"
        ? FEATURE_REGISTRY.filter((row) => row.tier === "pro").map(
            (row) => row.id,
          )
        : [],
    states: {
      ...value.states,
      ...Object.fromEntries(
        FEATURE_REGISTRY.filter((row) => row.tier === "pro").map((row) => [
          row.id,
          state,
        ]),
      ),
    },
  };
}
async function compose(
  options: {
    initial?: "locked" | "purchased" | "protected";
    accountOnly?: boolean;
    accountState?: "locked" | "purchased" | "verification_required";
    eligible?: boolean;
    verificationFails?: boolean;
    verificationHeld?: boolean;
    purchasePending?: boolean;
  } = {},
) {
  const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
  const writer = new AtomicSettingsWriter(storage);
  let rights = snapshot(options.initial ?? "locked");
  let pendingRoute: { route: "pro"; revision: number } | null = null;
  const purchased: NativeProResult = {
    outcome: "purchased",
    receipt: "entitled",
    productId: "still_pro_v3",
  };
  const purchase = vi.fn(async (): Promise<NativeProResult> =>
    options.purchasePending
      ? { outcome: "pending", receipt: "noSignal" }
      : purchased,
  );
  const restore = vi.fn(async (): Promise<NativeProResult> => ({
    outcome: "nothing",
    receipt: "verifiedNotEntitled",
  }));
  const linkPurchase = vi.fn(async () => ({
    status: "linked" as const,
    ownershipRevision: 1,
  }));
  const acknowledgments: number[] = [];
  const accountRequests: unknown[] = [];
  const accountId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const native = new NativeBridge({
    webkit: {
      messageHandlers: {
        still: {
          postMessage: async (message) => {
            const m = message as {
              kind: string;
              command?: string;
              revision?: number;
            };
            switch (m.kind) {
              case "get":
                return (await storage.get()) ?? "";
              case "settingsAtomic":
                return writer.initialize("unknown");
              case "reconcileAccountAccess":
                accountRequests.push(message);
                rights = snapshot(options.accountState ?? "purchased");
                return {schema: 1, status: "committed", generation: 2, accountId, sessionId,
                  issuerTime: 1800000000000, proofIdentities: options.accountState === "locked" ? [] : ["synthetic-access:" + "ab".repeat(64)]};
              case "getBenefitAccess":
                return { ok: true, snapshot: rights };
              case "proOffering":
                return {
                  offer: {
                    productId: "still_pro_v3",
                    offeringId: "still_pro_v3",
                    packageId: "$rc_lifetime",
                    package: "still-pro-v3",
                    kind: "lifetime",
                    price: "€9.99",
                    currencyCode: "EUR",
                  },
                };
              case "purchasePro":
                return purchase();
              case "restorePro":
                return restore();
              case "pendingAppRoute":
                return { pending: pendingRoute };
              case "acknowledgeAppRoute":
                acknowledgments.push(m.revision!);
                return { ok: true, revision: m.revision };
              default:
                return null;
            }
          },
        },
      },
    },
  });
  const adapter = new WKWebViewStorageAdapter({
    webkit: {
      messageHandlers: {
        still: {
          postMessage: async (message) => {
            const m = message as { kind: string };
            if (m.kind === "get") return (await storage.get()) ?? "";
            if (m.kind === "settingsAtomic")
              return writer.initialize("unknown");
            return null;
          },
        },
      },
    },
  });
  const cache = new SettingsCache(
    adapter,
    appleSettingsCacheOptions("atomic-local"),
  );
  cache.watch();
  await cache.hydrate();
  const authority = createAppleSettingsAuthority(cache, {
    native,
    initializer: adapter,
    hydration: cache.whenHydrated(),
  });
  authorities.push(authority);
  const controller = new UiController({ cache, host: { canPurchase: true },
    ...(options.accountOnly ? {auth: {signOut: async () => {}, currentVerifiedAccount: async () => ({id: accountId, email: "account@still.test", emailConfirmed: true})}} : {}),
  });
  const accountAuthority = options.accountOnly ? createApplePurchaseAuthority({
    trust: {environment: "sandbox", keys: []}, bridge: native,
    readVerifiedAccount: async () => controller.userId ? {id: controller.userId, emailConfirmed: true} : null,
    readAccessToken: async () => controller.userId ? {accountId: controller.userId, accessToken: "synthetic-transient-token", sessionId} : null,
    verifyLocal: async () => {throw new Error("Account-only cannot verify a local receipt");},
    fulfillLink: async () => {throw new Error("Account-only cannot link a receipt");},
  }) : undefined;
  if (accountAuthority) {
    controller.userId = accountId;
    controller.accountEmail = "account@still.test";
    await controller.refreshAccountConfirmation();
  }
  const openSignIn = vi.spyOn(controller, "openSignIn");
  const verifyLocalPurchase = vi.fn(async () => {
    if (options.verificationFails)
      throw new Error("Signed verification unavailable");
    rights = snapshot(
      options.verificationHeld ? "verification_required" : "purchased",
    );
    return authority.entitlement.refreshAccess();
  });
  const { default: Host } = (await import(/* @vite-ignore */ HOST_PATH)) as {
    default: Component<Record<string, unknown>>;
  };
  const view = render(Host, {
    props: {
      controller,
      authority,
      observeSetup: async () => null,
      help: {},
      proServices: {
        bridge: native,
        verifyLocalPurchase,
        ...(accountAuthority ? {refreshAccountAccess: accountAuthority.refreshAccountAccess} : {}),
        ownershipRevision: () => 0,
        readLinkEligibility: async () =>
          options.eligible === false ? null : { ownershipRevision: 0 },
        linkPurchase,
      },
    },
  });
  await screen.findByText("Still is active");
  return {
    view,
    authority,
    controller,
    accountRequests,
    setAccountState: (state: typeof options.accountState) => {options.accountState = state;},
    setNativeAccess: (state: "locked" | "purchased" | "protected") => {rights = snapshot(state);},
    openSignIn,
    verificationAvailable() {
      options.verificationFails = false;
      options.verificationHeld = false;
    },
    async setAccess(
      state: "locked" | "purchased" | "protected" | "verification_required",
    ) {
      rights = snapshot(state);
      await authority.entitlement.refreshAccess();
      await authority.entitlement.refreshAccess();
    },
    purchase,
    restore,
    verifyLocalPurchase,
    linkPurchase,
    acknowledgments,
    setRoute: (revision: number) => {
      pendingRoute = { route: "pro", revision };
    },
  };
}
describe("Apple settings to real native Pro screen integration", () => {
  it("opens D18, buys without sign-in and shows only verified local success", async () => {
    const f = await compose();
    await fireEvent.click(
      await screen.findByRole("button", { name: "Get Still Pro" }),
    );
    expect(f.purchase).not.toHaveBeenCalled();
    const buy = await screen.findByRole("button", { name: "Get Still Pro" });
    await fireEvent.click(buy);
    await waitFor(() => expect(f.verifyLocalPurchase).toHaveBeenCalledOnce());
    expect(await screen.findByText("You have Still Pro.")).toBeInTheDocument();
    expect(f.linkPurchase).not.toHaveBeenCalled();
  });
  it("warm native route opens the same destination and Restore shows conclusive Apple check", async () => {
    const f = await compose();
    f.setRoute(8);
    window.dispatchEvent(new Event("still:route"));
    await waitFor(() => expect(f.acknowledgments).toContain(8));
    await fireEvent.click(
      await screen.findByRole("button", { name: "Restore purchase" }),
    );
    expect(
      await screen.findByText(
        "No Still Pro purchase was found for this account.",
      ),
    ).toBeInTheDocument();
    expect(f.restore).toHaveBeenCalledOnce();
    expect(f.verifyLocalPurchase).not.toHaveBeenCalled();
  });
});

describe("mounted Apple host accepted access, provenance and verification recovery", () => {
  it("an accepted cache revocation updates an already open purchase view and removes linking", async () => {
    const f = await compose({ initial: "purchased" });
    f.setRoute(11);
    window.dispatchEvent(new Event("still:route"));
    await screen.findByText("You have Still Pro.");
    await f.setAccess("verification_required");
    await waitFor(() =>
      expect(screen.queryByText("You have Still Pro.")).toBeNull(),
    );
    expect(
      screen.queryByRole("button", { name: "Link Still Pro to an account" }),
    ).toBeNull();
    expect(f.linkPurchase).not.toHaveBeenCalled();
    expect(f.verifyLocalPurchase).not.toHaveBeenCalled();
  });
  it.each(["protected", "family", "account-only"] as const)(
    "%s benefits remain available without a purchaser-local link or sign-in prompt",
    async (provenance) => {
      const f = await compose({
        initial: provenance === "protected" ? "protected" : "purchased",
        eligible: false,
      });
      await f.setAccess(provenance === "protected" ? "protected" : "purchased");
      await waitFor(() =>
        expect(
          f.authority.entitlement.currentAccessSnapshot().states[
            "instagram.explore"
          ],
        ).toBe(provenance === "protected" ? "protected" : "purchased"),
      );
      expect(
        screen.queryByRole("button", { name: "Link Still Pro to an account" }),
      ).toBeNull();
      expect(f.openSignIn).not.toHaveBeenCalled();
      expect(f.linkPurchase).not.toHaveBeenCalled();
    },
  );
  it("failed signed fulfillment offers verification recovery instead of another acquisition", async () => {
    const f = await compose({ verificationFails: true });
    await fireEvent.click(
      await screen.findByRole("button", { name: "Get Still Pro" }),
    );
    await fireEvent.click(
      await screen.findByRole("button", { name: "Get Still Pro" }),
    );
    await screen.findByText("The purchase wasn't confirmed.");
    expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    expect(f.purchase).toHaveBeenCalledOnce();
    const verify = await screen.findByRole("button", { name: "Verify now" });
    expect(verify).toBeEnabled();
    await fireEvent.click(verify);
    await waitFor(() => expect(f.verifyLocalPurchase).toHaveBeenCalledTimes(2));
    expect(f.purchase).toHaveBeenCalledOnce();
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.linkPurchase).not.toHaveBeenCalled();
  });
});

describe("mounted Opus pending local fulfillment provenance", () => {
  it.each(["purchased", "protected"] as const)(
    "a rejected local verifier retains recovery despite accepted generic %s benefits",
    async (state) => {
      const f = await compose({ verificationFails: true, eligible: false });
      await fireEvent.click(
        await screen.findByRole("button", { name: "Get Still Pro" }),
      );
      await fireEvent.click(
        await screen.findByRole("button", { name: "Get Still Pro" }),
      );
      await screen.findByText("The purchase wasn't confirmed.");
      await f.setAccess(state);
      await fireEvent.click(
        await screen.findByRole("button", { name: "Verify now" }),
      );
      await waitFor(() =>
        expect(f.verifyLocalPurchase).toHaveBeenCalledTimes(2),
      );
      for (let i = 0; i < 24; i++) await Promise.resolve();
      expect(screen.queryByText("Still Pro is ready.")).toBeNull();
      expect(screen.getByRole("button", { name: "Verify now" })).toBeEnabled();
      expect(
        screen.queryByRole("button", { name: "Get Still Pro" }),
      ).toBeNull();
      expect(f.purchase).toHaveBeenCalledOnce();
      expect(f.restore).not.toHaveBeenCalled();
      expect(f.linkPurchase).not.toHaveBeenCalled();
    },
  );
});

describe("mounted settings pending verification recovery after closing", () => {
  const cases = (["buy", "restore"] as const).flatMap((kind) =>
    (["failed", "held"] as const).flatMap((mode) =>
      (["verification_required", "purchased", "protected"] as const).map(
        (state) => ({ kind, mode, state }),
      ),
    ),
  );
  it.each(cases)(
    "$kind $mode fulfillment remains recoverable from settings with $state access",
    async ({ kind, mode, state }) => {
      const f = await compose({
        verificationFails: mode === "failed",
        verificationHeld: mode === "held",
        purchasePending: mode === "held",
        eligible: false,
      });
      if (kind === "buy") {
        await fireEvent.click(
          await screen.findByRole("button", { name: "Get Still Pro" }),
        );
        await fireEvent.click(
          await screen.findByRole("button", { name: "Get Still Pro" }),
        );
      } else {
        f.restore.mockResolvedValue({
          outcome: "restored",
          receipt: "entitled",
          productId: "still_pro_v3",
        });
        f.setRoute(40);
        window.dispatchEvent(new Event("still:route"));
        await fireEvent.click(
          await screen.findByRole("button", { name: "Restore purchase" }),
        );
      }
      await screen.findByText("Your purchase needs to be verified.");
      await waitFor(() =>
        screen
          .getAllByRole("button", { name: "Verify now" })
          .forEach((button) => expect(button).toBeEnabled()),
      );
      await f.setAccess(state);
      await fireEvent.click(
        await screen.findByRole("button", { name: "Close" }),
      );
      await screen.findByText("Still is active");
      const verify = screen.getByRole("button", { name: "Verify purchase" });
      expect(verify).toBeEnabled();
      expect(
        screen.queryByRole("button", { name: "Get Still Pro" }),
      ).toBeNull();
      expect(
        screen.queryByText(
          "Go online and sign in. Free controls and your saved choices stay.",
        ),
      ).toBeNull();
      await fireEvent.click(verify);
      await waitFor(() =>
        expect(f.verifyLocalPurchase).toHaveBeenCalledTimes(2),
      );
      await waitFor(() =>
        screen
          .getAllByRole("button", { name: "Verify now" })
          .forEach((button) => expect(button).toBeEnabled()),
      );
      expect(
        screen.getAllByRole("button", { name: "Verify now" }),
      ).toHaveLength(1);
      expect(
        screen.queryByText(
          "Go online and sign in. Free controls and your saved choices stay.",
        ),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      await fireEvent.click(screen.getByRole("button", { name: "Verify now" }));
      await waitFor(() =>
        expect(f.verifyLocalPurchase).toHaveBeenCalledTimes(3),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Verify now" }),
        ).toBeEnabled(),
      );
      expect(f.purchase).toHaveBeenCalledTimes(kind === "buy" ? 1 : 0);
      expect(f.restore).toHaveBeenCalledTimes(kind === "restore" ? 1 : 0);
      expect(f.openSignIn).not.toHaveBeenCalled();
      expect(f.linkPurchase).not.toHaveBeenCalled();
      await fireEvent.click(
        await screen.findByRole("button", { name: "Close" }),
      );
      f.verificationAvailable();
      await fireEvent.click(
        await screen.findByRole("button", { name: "Verify purchase" }),
      );
      await waitFor(() =>
        expect(f.verifyLocalPurchase).toHaveBeenCalledTimes(4),
      );
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Verify now" })).toBeNull(),
      );
      await fireEvent.click(
        await screen.findByRole("button", { name: "Close" }),
      );
      expect(
        screen.queryByRole("button", { name: "Verify purchase" }),
      ).toBeNull();
      expect(f.purchase).toHaveBeenCalledTimes(kind === "buy" ? 1 : 0);
      expect(f.restore).toHaveBeenCalledTimes(kind === "restore" ? 1 : 0);
    },
  );
});

describe("pending locked Settings restore feedback", () => {
  it.each(["checking", "nothing", "cancelled"] as const)(
    "retains %s restore feedback without advertising acquisition",
    async (state) => {
      const f = await compose({
        verificationFails: true,
        purchasePending: true,
        eligible: false,
      });
      await fireEvent.click(
        await screen.findByRole("button", { name: "Get Still Pro" }),
      );
      await fireEvent.click(
        await screen.findByRole("button", { name: "Get Still Pro" }),
      );
      await screen.findByText("Your purchase needs to be verified.");
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Verify now" }),
        ).toBeEnabled(),
      );
      await fireEvent.click(
        await screen.findByRole("button", { name: "Close" }),
      );
      await screen.findByText("Still is active");
      let finish!: (result: NativeProResult) => void;
      const waiting = new Promise<NativeProResult>(
        (resolve) => (finish = resolve),
      );
      f.restore.mockImplementation(() => waiting);
      await fireEvent.click(
        screen.getByRole("button", { name: "Restore purchase" }),
      );
      await waitFor(() => expect(f.restore).toHaveBeenCalledTimes(1));
      try {
        if (state === "checking") {
          expect(
            screen.getByText("Checking for Still Pro purchases…"),
          ).toBeInTheDocument();
        } else {
          finish(
            state === "nothing"
              ? { outcome: "nothing", receipt: "verifiedNotEntitled" }
              : { outcome: "cancelled", receipt: "noSignal" },
          );
          await waitFor(() =>
            expect(
              screen.getByRole("button", { name: "Restore purchase" }),
            ).toBeEnabled(),
          );
          if (state === "nothing")
            await screen.findByText(
              "No Still Pro purchase was found for this Apple Account.",
            );
        }
        expect(
          screen.queryByText("No account needed. Payment is handled by Apple."),
        ).toBeNull();
        expect(
          screen.getByRole("button", { name: "Verify purchase" }),
        ).toBeEnabled();
        expect(
          screen.queryByRole("button", { name: "Get Still Pro" }),
        ).toBeNull();
        await fireEvent.click(
          screen.getByRole("button", { name: "YouTube Blocker" }),
        );
        const lock = screen.getByRole("button", {
          name: /^.+\. Included in Still Pro\./,
          description: "Comments",
        });
        expect(lock).toHaveAttribute("aria-disabled", "true");
        await fireEvent.click(lock);
        expect(
          screen.queryByRole("button", { name: "Get Still Pro" }),
        ).toBeNull();
        expect(f.purchase).toHaveBeenCalledTimes(1);
        expect(f.verifyLocalPurchase).toHaveBeenCalledTimes(1);
        expect(f.linkPurchase).not.toHaveBeenCalled();
        expect(f.openSignIn).not.toHaveBeenCalled();
      } finally {
        finish({ outcome: "cancelled", receipt: "noSignal" });
      }
    },
  );
});

describe("fresh Restore origin during an earlier pending purchase", () => {
  it.each(
    (["settings", "purchase"] as const).flatMap((surface) =>
      (["failed", "throw", "noSignal"] as const).map((outcome) => ({
        surface,
        outcome,
      })),
    ),
  )(
    "keeps $surface feedback for fresh $outcome Restore without acquiring again",
    async ({ surface, outcome }) => {
      const f = await compose({
        verificationFails: true,
        purchasePending: true,
        eligible: false,
      });
      await fireEvent.click(
        await screen.findByRole("button", { name: "Get Still Pro" }),
      );
      await fireEvent.click(
        await screen.findByRole("button", { name: "Get Still Pro" }),
      );
      await screen.findByText("Your purchase needs to be verified.");
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Verify now" }),
        ).toBeEnabled(),
      );
      if (surface === "settings") {
        await fireEvent.click(screen.getByRole("button", { name: "Close" }));
        await screen.findByText("Still is active");
      }
      if (outcome === "throw")
        f.restore.mockRejectedValueOnce(
          new Error("Native Restore unavailable"),
        );
      else
        f.restore.mockResolvedValueOnce({
          outcome: outcome === "noSignal" ? "nothing" : "failed",
          receipt: "noSignal",
        });
      await fireEvent.click(
        screen.getByRole("button", { name: "Restore purchase" }),
      );
      await waitFor(() => expect(f.restore).toHaveBeenCalledTimes(1));
      if (outcome !== "noSignal") {
        await screen.findByText(
          "We couldn't finish checking. Nothing changed.",
        );
        const retry = screen.getByRole("button", { name: "Try again" });
        expect(retry).toBeEnabled();
        f.restore.mockResolvedValueOnce({
          outcome: "nothing",
          receipt: "verifiedNotEntitled",
        });
        await fireEvent.click(retry);
        await waitFor(() => expect(f.restore).toHaveBeenCalledTimes(2));
        await screen.findByText(
          surface === "settings"
            ? "No Still Pro purchase was found for this Apple Account."
            : "No Still Pro purchase was found for this account.",
        );
      } else {
        await waitFor(() =>
          expect(
            screen.getByRole("button", { name: "Restore purchase" }),
          ).toBeEnabled(),
        );
        expect(
          screen.queryByText(
            "Go online and sign in. Free controls and your saved choices stay.",
          ),
        ).toBeNull();
      }
      expect(
        screen.getByText("Your purchase needs to be verified."),
      ).toBeInTheDocument();
      expect(
        screen.getAllByRole("button", {
          name: surface === "settings" ? "Verify purchase" : "Verify now",
        }),
      ).toHaveLength(1);
      expect(
        screen.queryByRole("button", { name: "Get Still Pro" }),
      ).toBeNull();
      expect(f.purchase).toHaveBeenCalledTimes(1);
      expect(f.verifyLocalPurchase).toHaveBeenCalledTimes(1);
      expect(f.openSignIn).not.toHaveBeenCalled();
      expect(f.linkPurchase).not.toHaveBeenCalled();
    },
  );
});

describe("Restore signed-verifier progress survives accepted cache publications", () => {
  it.each(
    (["settings", "purchase"] as const).flatMap((surface) =>
      (["failed", "held", "owned"] as const).map((result) => ({
        surface,
        result,
      })),
    ),
  )(
    "retains $surface checking and rating hold until verifier $result",
    async ({ surface, result }) => {
      vi.mocked(reportRatingHold).mockClear();
      const f = await compose({
        verificationFails: result === "failed",
        verificationHeld: result === "held",
        eligible: false,
      });
      if (surface === "purchase") {
        f.setRoute(40);
        window.dispatchEvent(new Event("still:route"));
        await screen.findByRole("button", { name: "Close" });
      }
      f.restore.mockResolvedValueOnce({
        outcome: "restored",
        receipt: "entitled",
        productId: "still_pro_v3",
      });
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => (release = resolve));
      const verify = f.verifyLocalPurchase.getMockImplementation()!;
      f.verifyLocalPurchase.mockImplementationOnce(async () => {
        await waiting;
        return verify();
      });
      await fireEvent.click(
        screen.getByRole("button", { name: "Restore purchase" }),
      );
      await waitFor(() =>
        expect(f.verifyLocalPurchase).toHaveBeenCalledTimes(1),
      );
      try {
        // A genuine newer cache publication must not drop this operation's in-flight progress.
        await f.setAccess("verification_required");
        await screen.findByText("Checking for Still Pro purchases…");
        const restore = screen.queryByRole("button", {
          name: "Restore purchase",
        });
        // The shared purchase screen hides held Restore; the card may render it disabled.
        if (restore) expect(restore).toBeDisabled();
        await waitFor(() =>
          expect(reportRatingHold).toHaveBeenLastCalledWith("restore"),
        );
        release();
        await waitFor(() =>
          expect(
            screen.queryByText("Checking for Still Pro purchases…"),
          ).toBeNull(),
        );
        if (result === "owned") {
          await screen.findByText("Still Pro is restored on this device.");
          expect(
            screen.queryByRole("button", { name: "Verify purchase" }),
          ).toBeNull();
          expect(
            screen.queryByRole("button", { name: "Verify now" }),
          ).toBeNull();
        } else {
          await screen.findByText("Your purchase needs to be verified.");
          expect(
            screen.getAllByRole("button", {
              name: surface === "settings" ? "Verify purchase" : "Verify now",
            }),
          ).toHaveLength(1);
          expect(
            screen.queryByRole("button", { name: "Try again" }),
          ).toBeNull();
          expect(
            screen.queryByText(
              "Go online and sign in. Free controls and your saved choices stay.",
            ),
          ).toBeNull();
        }
        expect(f.restore).toHaveBeenCalledTimes(1);
        expect(f.purchase).not.toHaveBeenCalled();
        expect(f.linkPurchase).not.toHaveBeenCalled();
        expect(f.openSignIn).not.toHaveBeenCalled();
      } finally {
        release();
      }
    },
  );
});


describe("mounted Apple account-only native authority", () => {
  it("launch recovers a web purchase through typed native commit and renders accepted Pro", async () => {
    const f = await compose({accountOnly: true});
    f.setRoute(91);
    window.dispatchEvent(new Event("still:route"));
    expect(await screen.findByText("You have Still Pro.")).toBeInTheDocument();
    expect(f.accountRequests.length).toBeGreaterThan(0);
    expect(f.accountRequests[0]).toEqual({kind:"reconcileAccountAccess",accessToken:"synthetic-transient-token"});
    expect(f.verifyLocalPurchase).not.toHaveBeenCalled();
    expect(f.purchase).not.toHaveBeenCalled();
    expect(f.linkPurchase).not.toHaveBeenCalled();
  });
  it("Restore unlocks account-only access through the real native bridge without local verification", async () => {
    const f = await compose({accountOnly: true, accountState: "locked"});
    f.setAccountState("purchased");
    await fireEvent.click(await screen.findByRole("button", {name: "Restore purchase"}));
    expect(await screen.findByText("Still Pro is restored on this device.")).toBeInTheDocument();
    expect(f.verifyLocalPurchase).not.toHaveBeenCalled();
    expect(f.purchase).not.toHaveBeenCalled();
    expect(f.linkPurchase).not.toHaveBeenCalled();
  });
  it("native lineage notification refreshes the existing cache on sign-out and preserves local Pro", async () => {
    const f = await compose({accountOnly: true});
    f.setRoute(92);
    window.dispatchEvent(new Event("still:route"));
    await screen.findByText("You have Still Pro.");
    f.controller.userId = null;
    f.controller.accountEmail = null;
    // Native already committed account removal while preserving its independent local lane.
    f.setNativeAccess("protected");
    window.dispatchEvent(new Event("still:accountAccess"));
    await waitFor(() => expect(f.authority.entitlement.currentAccessSnapshot().independentProtection.length).toBeGreaterThan(0));
    expect(await screen.findByText("You have Still Pro.")).toBeInTheDocument();
    expect(f.purchase).not.toHaveBeenCalled();
  });
});


describe("mounted Apple known account removal", () => {
  it("native account-only removal after sign-out updates an already open purchase view", async () => {
    const f = await compose({accountOnly: true});
    f.setRoute(93);
    window.dispatchEvent(new Event("still:route"));
    await screen.findByText("You have Still Pro.");
    f.controller.userId = null;
    f.controller.accountEmail = null;
    f.setNativeAccess("locked");
    window.dispatchEvent(new Event("still:accountAccess"));
    await waitFor(() => expect(screen.queryByText("You have Still Pro.")).toBeNull());
    expect(f.verifyLocalPurchase).not.toHaveBeenCalled();
    expect(f.purchase).not.toHaveBeenCalled();
    expect(f.linkPurchase).not.toHaveBeenCalled();
  });
});
