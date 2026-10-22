import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
import { AtomicSettingsWriter, type SettingsIntent } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { WKWebViewStorageAdapter } from "../../storage/wkwebview-adapter.js";
import { createApplePurchaseAuthority } from "../../native/apple-purchase-authority.js";
import {
  NativeBridge,
  type NativeProResult,
  type SafariSetupObservation,
} from "../../native/bridge.js";
import {
  ACCESS_BENEFITS,
  initialAccessSnapshot,
} from "../../entitlement/access-policy.js";
import { UiController } from "../controller.svelte.js";
import { STRINGS } from "../strings.js";
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
    /** "none": the signed-in account holds no rights, while the device keeps its local proof
     * (an accountless Apple buyer who signs in; ISS-0076). */
    accountState?: "locked" | "purchased" | "verification_required" | "none";
    accountUncertain?: "unavailable" | "conflict";
    /** The app's native account lane (reconcile on sign-in) with the email-code sign-in, starting
     * signed out: the path a real sign-in from Settings takes (ISS-0076). Implies `codeAuth`. */
    accountAccess?: boolean;
    /** Native refuses the link-eligibility read this many times (a reconcile in flight), then answers. */
    refuseEligibility?: number;
    eligible?: boolean;
    /** ISS-0081: the account native's current server-signed account proof links the right to. Native
     * holds that proof only once the signed-in account's reconcile has installed it (a new session
     * starts with none), so it names the account only after that. */
    linkedAccount?: string | null;
    /** ISS-0105: the authority's positive account provenance read (a verified account proof for
     * the signed-in account in native's record). Absent, the host has no such read. */
    accountHeldPro?: boolean;
    verificationFails?: boolean;
    verificationHeld?: boolean;
    purchasePending?: boolean;
    observeSetup?: () => Promise<SafariSetupObservation | null>;
    /** The app's email-code sign-in, starting signed out (ISS-0071). */
    codeAuth?: boolean;
  } = {},
) {
  const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
  const writer = new AtomicSettingsWriter(storage);
  let rights = snapshot(options.initial ?? "locked");
  let pendingRoute: { route: "pro" | "sync"; revision: number } | null = null;
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
  // ISS-0071: hold the pre-sheet offer read, and choose who the next code sign-in is.
  let offeringGate: Promise<void> | null = null;
  // ISS-0076: hold the native link-eligibility reads, as slow StoreKit answers do on a device, and
  // let them finish one at a time (each read returns on its own there, never in one flush).
  let eligibilityHeld = false;
  const eligibilityWaiters: Array<() => void> = [];
  let refusedEligibility = 0;
  // ISS-0081: the account proof exists on the device only after a reconcile installed it.
  let proofInstalled = false;
  let reconcileGate: Promise<void> | null = null;
  if (options.accountAccess) options.codeAuth = true;
  let nextAccount = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "account@still.test" };
  // ISS-0076 (MAC-85): the app's verified code awaits the session entry (AppleSession.enterSession)
  // before the controller sees it. The entry advances the account revision and publishes the account
  // (the settings mirror's sync state); the controller then advances the revision once more.
  let sessionEntryGate: Promise<void> | null = null;
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
                if (reconcileGate) await reconcileGate;
                if (options.linkedAccount) {
                  proofInstalled = true;
                  // Installing the proof advances native's record, so the cache publishes again.
                  rights = { ...snapshot(options.accountState === "none" || !options.accountState ? "purchased" : options.accountState), generation: rights.generation + 1 };
                  return {schema: 1, status: "committed", accountStatus: "verified", generation: 2, accountId, sessionId,
                    issuerTime: 1800000000000, proofIdentities: ["synthetic-access:" + "ab".repeat(64)]};
                }
                // "none" leaves the device's own rights alone: the account adds nothing. Binding the
                // session still advances native's record generation, so the next read is a new snapshot.
                if (!options.accountUncertain && options.accountState !== "none") rights = snapshot(options.accountState ?? "purchased");
                else if (options.accountState === "none") rights = { ...rights, generation: rights.generation + 1 };
                return {schema: 1, status: "committed", accountStatus: options.accountUncertain ? options.accountUncertain : options.accountState === "locked" || options.accountState === "none" ? "none" : "verified", generation: 2, accountId, sessionId,
                  issuerTime: 1800000000000, proofIdentities: options.accountUncertain || options.accountState === "locked" || options.accountState === "none" ? [] : ["synthetic-access:" + "ab".repeat(64)]};
              case "getBenefitAccess":
                return { ok: true, snapshot: rights };
              case "proOffering":
                if (offeringGate) await offeringGate;
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
                if (pendingRoute?.revision === m.revision) pendingRoute = null;
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
            if (m.kind === "settingsIntent") return writer.commit(message as SettingsIntent);
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
  const controller: UiController = new UiController({ cache, host: { canPurchase: true },
    ...(options.accountOnly ? {auth: {signOut: async () => {}, currentVerifiedAccount: async () => ({id: accountId, email: "account@still.test", emailConfirmed: true})}} : {}),
    ...(options.codeAuth ? {auth: {
      signOut: async () => {},
      requestCode: async () => ({ kind: "sent" as const }),
      verifyCode: async () => {
        if (sessionEntryGate) {
          controller.accountRevision++;
          controller.userId = nextAccount.id;
          controller.accountEmail = nextAccount.email;
          await sessionEntryGate;
        }
        return { kind: "verified" as const, userId: nextAccount.id, email: nextAccount.email };
      },
      currentVerifiedAccount: async () => controller.userId
        ? {id: controller.userId, email: controller.accountEmail ?? "", emailConfirmed: true} : null,
    }} : {}),
  });
  const accountAuthority = options.accountOnly || options.accountAccess ? createApplePurchaseAuthority({
    trust: {environment: "sandbox", keys: []}, bridge: native,
    readVerifiedAccount: async () => controller.userId ? {id: controller.userId, emailConfirmed: true} : null,
    readAccessToken: async () => controller.userId ? {accountId: controller.userId, accessToken: "synthetic-transient-token", sessionId} : null,
    verifyLocal: async () => {throw new Error("Account-only cannot verify a local receipt");},
    fulfillLink: async () => {throw new Error("Account-only cannot link a receipt");},
  }) : undefined;
  if (accountAuthority && options.accountOnly) {
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
      observeSetup: options.observeSetup ?? (async () => null),
      help: {},
      proServices: {
        bridge: native,
        verifyLocalPurchase,
        ...(accountAuthority ? {refreshAccountAccess: accountAuthority.refreshAccountAccess} : {}),
        ownershipRevision: () => 0,
        readLinkEligibility: async () => {
          if (eligibilityHeld) await new Promise<void>((resolve) => eligibilityWaiters.push(resolve));
          if (options.refuseEligibility && refusedEligibility < options.refuseEligibility) {
            refusedEligibility++;
            throw new Error("still: Apple link eligibility requires verification");
          }
          return options.eligible === false
            ? null
            : { ownershipRevision: 0, linkedAccount: controller.userId && proofInstalled ? (options.linkedAccount ?? null) : null };
        },
        ...(options.accountHeldPro !== undefined
          ? { readAccountHeldPro: async (id: string) => options.accountHeldPro === true && id === controller.userId }
          : {}),
        linkPurchase,
      },
      appRoutes: native,
    },
  });
  await screen.findByText("Still is active");
  return {
    view,
    cache,
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
    holdOffering() {
      let release!: () => void;
      offeringGate = new Promise<void>((resolve) => { release = resolve; });
      return () => { offeringGate = null; release(); };
    },
    /** Native refuses the next `n` link-eligibility reads (a reconcile in flight), then answers. */
    refuseEligibility(n: number) { options.refuseEligibility = n; refusedEligibility = 0; },
    holdEligibility() {
      eligibilityHeld = true;
      return {
        waiting: () => eligibilityWaiters.length,
        releaseOne: () => eligibilityWaiters.shift()?.(),
        releaseAll: () => {
          eligibilityHeld = false;
          eligibilityWaiters.splice(0).forEach((resolve) => resolve());
        },
      };
    },
    nextSignIn(id: string, email: string) { nextAccount = { id, email }; },
    /** Holds the verified code inside the session entry (account published, one revision ahead). */
    holdSessionEntry() {
      let release!: () => void;
      sessionEntryGate = new Promise<void>((resolve) => { release = resolve; });
      return () => { sessionEntryGate = null; release(); };
    },
    verifyLocalPurchase,
    linkPurchase,
    /** Holds the account reconcile (and so the proof it installs) until released. */
    holdReconcile() {
      let release!: () => void;
      reconcileGate = new Promise<void>((resolve) => { release = resolve; });
      return () => { reconcileGate = null; release(); };
    },
    acknowledgments,
    setRoute: (revision: number, route: "pro" | "sync" = "pro") => {
      pendingRoute = { route, revision };
    },
  };
}
// Owner rule (12 Oct 2026, ISS-0029): no Still Pro surface states a number of extras, on any
// platform answer, neither the settings card nor the Still Pro screen that Get Still Pro opens.
const EXTRAS_COUNT = /\b\d+ of the \d+\b|extras work|need(?:s)? a computer/i;
describe("Still Pro states no number of extras on any platform answer", () => {
  async function noCount() {
    const card = await screen.findByRole("region", { name: "Still Pro" });
    expect(card).not.toHaveTextContent(EXTRAS_COUNT);
    await fireEvent.click(
      await screen.findByRole("button", { name: "Get Still Pro" }),
    );
    expect(
      await screen.findByRole("button", { name: "Get Still Pro" }),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent(EXTRAS_COUNT);
  }
  it("a setup read that times out (a Mac that never answered)", async () => {
    await compose({ observeSetup: () => new Promise(() => {}) });
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    await noCount();
    // A real 2.2 s wait for the bounded setup read, plus mounting: the default 5 s budget left too
    // little room on a loaded machine.
  }, 10_000);
  it("a read that observes nothing", async () => {
    await compose({ observeSetup: async () => null });
    await noCount();
  });
  it("a confirmed Mac", async () => {
    await compose({
      observeSetup: async () => ({
        ok: true,
        platform: "macos",
        extensionStatus: "enabled",
        enableLocation: "safariExtensionSettings",
      }),
    });
    await noCount();
  });
  it("a confirmed iPhone/iPad (the iOS app on iPad reports ios)", async () => {
    await compose({
      observeSetup: async () => ({
        ok: true,
        platform: "ios",
        extensionStatus: "unknown",
        enableLocation: "settingsAppStillPage",
      }),
    });
    await noCount();
  });
});

describe("Apple settings to real native Pro screen integration", () => {
  it("all twelve Mac locks open the full offer and Close preserves focus, section and free settings", async () => {
    const f = await compose({ observeSetup: async () => ({
      ok: true, platform: "macos", extensionStatus: "enabled", enableLocation: "safariExtensionSettings",
    }) });
    await screen.findByRole("button", { name: "Get Still Pro" });
    const saved = f.cache.currentRecord();
    let visited = 0;
    for (const section of ["Instagram Blocker", "Facebook Blocker", "YouTube Blocker"]) {
      const expander = screen.getByRole("button", { name: section });
      if (expander.getAttribute("aria-expanded") !== "true") await fireEvent.click(expander);
      const locks = within(expander.closest(".site-section") as HTMLElement).getAllByRole("button", { name: /^.+\. Included in Still Pro\./ });
      for (const lock of locks) {
        lock.focus();
        await fireEvent.click(lock);
        const close = await screen.findByRole("button", { name: "Close" });
        expect(close).toHaveFocus();
        expect(screen.getByRole("heading", { name: "Still Pro" })).toBeVisible();
        expect(f.purchase).not.toHaveBeenCalled();
        await fireEvent.click(close);
        await waitFor(() => expect(lock).toHaveFocus());
        expect(expander).toHaveAttribute("aria-expanded", "true");
        expect(f.cache.currentRecord()).toEqual(saved);
        visited++;
      }
    }
    expect(visited).toBe(12);
    await fireEvent.click(screen.getByRole("switch", { name: "TikTok website" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "TikTok website" })).toHaveAttribute("aria-checked", "false"));
    expect(f.purchase).not.toHaveBeenCalled();
  });

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

describe("still://sync, the Safari popup's Sign in hand-off", () => {
  it("signed out: leaves the Still Pro screen and opens sign-in over Settings", async () => {
    const f = await compose();
    vi.spyOn(f.controller, "canSignIn", "get").mockReturnValue(true);
    f.setRoute(20);
    window.dispatchEvent(new Event("still:route"));
    await waitFor(() => expect(f.acknowledgments).toContain(20));
    expect(await screen.findByRole("button", { name: "Close" })).toBeInTheDocument();
    f.setRoute(21, "sync");
    window.dispatchEvent(new Event("still:route"));
    await waitFor(() => expect(f.acknowledgments).toContain(21));
    expect(f.openSignIn).toHaveBeenCalledOnce();
    expect(f.controller.signInOpen).toBe(true);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(await screen.findByText("Still is active")).toBeInTheDocument();
  });

  it("a sync route is taken once, and the Pro host never opens for it", async () => {
    const f = await compose();
    vi.spyOn(f.controller, "canSignIn", "get").mockReturnValue(true);
    f.setRoute(30, "sync");
    window.dispatchEvent(new Event("still:route"));
    await waitFor(() => expect(f.acknowledgments).toEqual([30]));
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    window.dispatchEvent(new Event("still:route"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.acknowledgments).toEqual([30]);
    expect(f.openSignIn).toHaveBeenCalledOnce();
  });

  it("a build that cannot sign in shows the sync card and opens no dead sign-in sheet", async () => {
    const f = await compose();
    vi.spyOn(f.controller, "canSignIn", "get").mockReturnValue(false);
    f.setRoute(50, "sync");
    window.dispatchEvent(new Event("still:route"));
    await waitFor(() => expect(f.acknowledgments).toContain(50));
    expect(f.openSignIn).not.toHaveBeenCalled();
  });

  it("signed in: shows Settings with the account and opens no sign-in", async () => {
    const f = await compose({ accountOnly: true });
    f.openSignIn.mockClear();
    f.setRoute(40, "sync");
    window.dispatchEvent(new Event("still:route"));
    await waitFor(() => expect(f.acknowledgments).toContain(40));
    expect(f.openSignIn).not.toHaveBeenCalled();
    expect(f.controller.signInOpen).toBe(false);
    // The real Settings screen's sync card is the one brought into view and focused.
    await waitFor(() =>
      expect(document.activeElement?.querySelector("h2")?.textContent?.trim()).toMatch(/sync$/),
    );
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

describe("mounted Apple Buy the App Store never started (ISS-0070)", () => {
  const notStarted = "Still Pro couldn't be bought right now.";
  const notStartedDetail =
    "Nothing was charged. Make sure you're signed in to the App Store, then try again.";
  const ambiguous = "The purchase wasn't confirmed.";
  const ambiguousDetail = "If you were charged, Restore purchase will find it.";
  it("a native unavailable Buy says nothing was charged on the purchase view and the card", async () => {
    const f = await compose();
    f.purchase.mockResolvedValueOnce({ outcome: "unavailable", receipt: "noSignal" });
    await fireEvent.click(await screen.findByRole("button", { name: "Get Still Pro" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Get Still Pro" }));
    await screen.findByText(notStarted);
    expect(screen.getByText(notStartedDetail)).toBeInTheDocument();
    expect(screen.queryByText(ambiguous)).toBeNull();
    expect(screen.queryByText(ambiguousDetail)).toBeNull();
    expect(screen.queryByText("Your purchase needs to be verified.")).toBeNull();
    expect(f.purchase).toHaveBeenCalledOnce();
    expect(f.verifyLocalPurchase).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const card = await screen.findByRole("region", { name: "Still Pro" });
    await within(card).findByText(notStarted);
    expect(within(card).getByText(notStartedDetail)).toBeInTheDocument();
    expect(within(card).queryByText(ambiguous)).toBeNull();
    expect(within(card).queryByText(ambiguousDetail)).toBeNull();
    expect(within(card).getByRole("button", { name: "Try again" })).toBeEnabled();
  });
  it("an ambiguous native failed Buy keeps the may-have-been-charged copy", async () => {
    const f = await compose();
    f.purchase.mockResolvedValueOnce({ outcome: "failed", receipt: "noSignal" });
    await fireEvent.click(await screen.findByRole("button", { name: "Get Still Pro" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Get Still Pro" }));
    await screen.findByText(ambiguous);
    expect(screen.getByText(ambiguousDetail)).toBeInTheDocument();
    expect(screen.queryByText(notStarted)).toBeNull();
    expect(screen.queryByText(notStartedDetail)).toBeNull();
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
  it.each(["unavailable", "conflict"] as const)("%s account verification cannot start an Apple charge on an empty cache", async accountUncertain => {
    const f = await compose({accountOnly: true, accountUncertain});
    await fireEvent.click(await screen.findByRole("button", {name: "Get Still Pro"}));
    await fireEvent.click(await screen.findByRole("button", {name: "Get Still Pro"}));
    await screen.findByText("The purchase wasn't confirmed.");
    expect(f.accountRequests.length).toBeGreaterThan(0);
    expect(f.purchase).not.toHaveBeenCalled();
    expect(f.verifyLocalPurchase).not.toHaveBeenCalled();
    expect(f.linkPurchase).not.toHaveBeenCalled();
  });
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
  it.each(["unavailable", "conflict"] as const)("%s native account authority keeps cached Pro but cannot confirm Restore", async accountUncertain => {
    const f = await compose({accountOnly: true, accountUncertain});
    // The native cache changes before the mounted screen receives its next observation.
    f.setNativeAccess("purchased");
    await fireEvent.click(await screen.findByRole("button", {name: "Restore purchase"}));
    await waitFor(() => expect(f.restore).toHaveBeenCalledOnce());
    await waitFor(() => expect(f.authority.entitlement.currentAccessSnapshot().states["youtube.related"]).toBe("purchased"));
    expect(screen.queryByText("Still Pro is restored on this device.")).toBeNull();
    expect(f.authority.entitlement.currentAccessSnapshot().states["youtube.related"]).toBe("purchased");
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

// ISS-0071 (owner decision, option B; ADR 0005): signed out, Get Still Pro opens the app's
// email-code sign-in first, with one added line and "Buy without an account" under it.
describe("mounted Apple Still Pro purchase starts with sign-in (ISS-0071)", () => {
  const NOTE = "Sign in before purchase to associate Still Pro with your account.";
  const SKIP = "Buy without an account";
  async function enterCode(address: string) {
    const email = await screen.findByRole("textbox", { name: STRINGS.auth.emailLabel });
    await fireEvent.input(email, { target: { value: address } });
    await fireEvent.click(screen.getByRole("button", { name: STRINGS.codeAuth.send }));
    const code = await screen.findByRole("textbox", { name: STRINGS.codeAuth.codeLabel });
    await fireEvent.input(code, { target: { value: "123456" } });
    await fireEvent.click(screen.getByRole("button", { name: STRINGS.codeAuth.verify }));
  }
  async function openBuy() {
    const f = await compose({ codeAuth: true });
    await fireEvent.click(await screen.findByRole("button", { name: "Get Still Pro" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Get Still Pro" }));
    return f;
  }
  it("signed out, Get Still Pro opens the email-code sign-in with the line and the skip link", async () => {
    const f = await openBuy();
    const sheet = await screen.findByRole("dialog");
    // ISS-0085 (owner, 19 Oct): the purchase-opened sheet has its own heading and prompt.
    expect(within(sheet).getByRole("heading", { name: "Sign in to purchase Still Pro" })).toBeVisible();
    expect(within(sheet).getByText("Enter your email to get a 6-digit code.")).toBeVisible();
    expect(within(sheet).queryByText(STRINGS.auth.prompt)).toBeNull();
    expect(within(sheet).getByText(NOTE)).toBeVisible();
    expect(within(sheet).getByRole("button", { name: SKIP })).toBeVisible();
    expect(within(sheet).getByRole("textbox", { name: STRINGS.auth.emailLabel })).toBeVisible();
    expect(f.purchase).not.toHaveBeenCalled();
  });
  it("cancelling sign-in opens no Apple sheet, and a later sign-in buys nothing", async () => {
    const f = await openBuy();
    const sheet = await screen.findByRole("dialog");
    await fireEvent.click(within(sheet).getByRole("button", { name: STRINGS.auth.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.purchase).not.toHaveBeenCalled();
    expect(f.controller.userId).toBeNull();
    // Sign in afterwards, for sync: no purchase line, no skip link, and no Apple sheet.
    f.controller.openSignIn();
    const again = await screen.findByRole("dialog");
    // The sync-opened sheet keeps its own words (ISS-0085).
    expect(within(again).getByRole("heading", { name: STRINGS.auth.title })).toBeVisible();
    expect(within(again).getByText(STRINGS.auth.prompt)).toBeVisible();
    expect(within(again).queryByText(NOTE)).toBeNull();
    expect(within(again).queryByRole("button", { name: SKIP })).toBeNull();
    await enterCode("account@still.test");
    await waitFor(() => expect(f.controller.accountConfirmed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.purchase).not.toHaveBeenCalled();
    expect(f.linkPurchase).not.toHaveBeenCalled();
  });
  it("signing out while the continued purchase is still checking opens no sheet on a later sign-in", async () => {
    const f = await openBuy();
    const release = f.holdOffering();
    await enterCode("account@still.test");
    await waitFor(() => expect(f.controller.accountConfirmed).toBe(true));
    await f.controller.signOut();
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    f.controller.openSignIn();
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByRole("button", { name: SKIP })).toBeNull();
    await enterCode("account@still.test");
    await waitFor(() => expect(f.controller.accountConfirmed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.purchase).not.toHaveBeenCalled();
    expect(f.linkPurchase).not.toHaveBeenCalled();
  });
  it("switching to another account while the continued purchase is checking opens no sheet and links nothing", async () => {
    const f = await openBuy();
    const release = f.holdOffering();
    await enterCode("account@still.test");
    await waitFor(() => expect(f.controller.accountConfirmed).toBe(true));
    await f.controller.signOut();
    f.nextSignIn("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "other@still.test");
    f.controller.openSignIn();
    await enterCode("other@still.test");
    await waitFor(() => expect(f.controller.userId).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd"));
    await waitFor(() => expect(f.controller.accountConfirmed).toBe(true));
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.purchase).not.toHaveBeenCalled();
    expect(f.linkPurchase).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("Buy without an account goes straight to Apple's sheet, as before", async () => {
    const f = await openBuy();
    await fireEvent.click(await screen.findByRole("button", { name: SKIP }));
    await waitFor(() => expect(f.purchase).toHaveBeenCalledOnce());
    expect(await screen.findByText("You have Still Pro.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.linkPurchase).not.toHaveBeenCalled();
    expect(f.controller.userId).toBeNull();
  });
  it("right after a purchase without an account, Back to settings shows the sign-in card", async () => {
    await openBuy();
    await fireEvent.click(await screen.findByRole("button", { name: SKIP }));
    expect(await screen.findByText("You have Still Pro.")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Back to settings" }));
    expect(await screen.findByText("You have Still Pro. Sign in to keep Still Pro with your account.")).toBeVisible();
    expect(screen.queryByText("Link Still Pro to an account")).toBeNull();
  });
  it("signing in continues to Apple's sheet without a second tap and links the purchase", async () => {
    const f = await openBuy();
    const email = await screen.findByRole("textbox", { name: STRINGS.auth.emailLabel });
    await fireEvent.input(email, { target: { value: "account@still.test" } });
    await fireEvent.click(screen.getByRole("button", { name: STRINGS.codeAuth.send }));
    const code = await screen.findByRole("textbox", { name: STRINGS.codeAuth.codeLabel });
    await fireEvent.input(code, { target: { value: "123456" } });
    expect(f.purchase).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: STRINGS.codeAuth.verify }));
    await waitFor(() => expect(f.purchase).toHaveBeenCalledOnce());
    await waitFor(() => expect(f.linkPurchase).toHaveBeenCalledOnce());
    expect(f.linkPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ intendedAccountId: f.controller.userId, expectedOwnershipRevision: 0 }),
    );
    expect(await screen.findByText("You have Still Pro.")).toBeInTheDocument();
  });
  it("the purchase screen never says No account needed", async () => {
    await openBuy();
    expect(document.body.textContent).not.toMatch(/No account needed/i);
    expect(screen.getByText("Payment is handled by Apple.")).toBeInTheDocument();
  });
  it("an accountless holder sees the sign-in card; Not now hides it and Sign in runs the explicit link", async () => {
    const f = await compose({ codeAuth: true, initial: "purchased" });
    // The invitation lives in the sync card (owner, 19 Oct): Sign in, Not now and the one line.
    const line = await screen.findByText("You have Still Pro. Sign in to keep Still Pro with your account.");
    const card = line.closest("section")!;
    expect(within(card).getByRole("heading", { name: "Settings sync" })).toBeVisible();
    expect(within(card).getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(within(card).getByRole("button", { name: "Not now" })).toBeVisible();
    expect(screen.queryByText("Link Still Pro to an account")).toBeNull();
    expect(screen.queryByText("So you can restore it in other browsers. Optional.")).toBeNull();
    await fireEvent.click(within(card).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(f.controller.signInOpen).toBe(true));
    const sheet = await screen.findByRole("dialog");
    // The explicit link's sign-in is not a purchase: no purchase line, no skip link.
    expect(within(sheet).queryByText(NOTE)).toBeNull();
    expect(within(sheet).queryByRole("button", { name: SKIP })).toBeNull();
    expect(f.purchase).not.toHaveBeenCalled();
    expect(f.linkPurchase).not.toHaveBeenCalled();
  });
  it("Not now hides the accountless holder's card", async () => {
    await compose({ codeAuth: true, initial: "purchased" });
    const line = await screen.findByText("You have Still Pro. Sign in to keep Still Pro with your account.");
    const card = line.closest("section")!;
    await fireEvent.click(within(card).getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(screen.queryByText("You have Still Pro. Sign in to keep Still Pro with your account.")).toBeNull(),
    );
    // The plain Sign in stays available on the card.
    expect(within(card).getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});
// ISS-0076: on 2.1.1.383 a Mac holding an accountless Still Pro showed the invitation, but signing in
// from it landed on the main screen with no "Link Still Pro to this account?" and nothing to link
// with afterwards. The fixture here is the real host with the native account lane the app wires
// (reconcile on sign-in), an account that holds nothing, and a link-eligibility read that can be
// held open, as StoreKit's answer is on a device.
describe("mounted Apple accountless holder signs in to link Still Pro (ISS-0076)", () => {
  const INVITE = "You have Still Pro. Sign in to keep Still Pro with your account.";
  const OFFER = "Link Still Pro to your account.";
  // The invitation lives in the sync card (owner, 19 Oct); its Sign in runs the explicit link.
  const inviteCard = async () => (await screen.findByText(INVITE)).closest("section")!;
  const ACCOUNT = "account@still.test";
  async function holder() {
    return compose({ accountAccess: true, initial: "purchased", accountState: "none" });
  }
  async function enterCode() {
    const email = await screen.findByRole("textbox", { name: STRINGS.auth.emailLabel });
    await fireEvent.input(email, { target: { value: ACCOUNT } });
    await fireEvent.click(screen.getByRole("button", { name: STRINGS.codeAuth.send }));
    const code = await screen.findByRole("textbox", { name: STRINGS.codeAuth.codeLabel });
    await fireEvent.input(code, { target: { value: "123456" } });
    await fireEvent.click(screen.getByRole("button", { name: STRINGS.codeAuth.verify }));
  }
  async function confirmation() {
    const card = await screen.findByRole("region", { name: "Link Still Pro" });
    expect(within(card).getByRole("heading", { name: "Link Still Pro to this account?" })).toBeVisible();
    expect(within(card).getByText(ACCOUNT)).toBeVisible();
    expect(within(card).getByText("You'll use this account to restore Still Pro in other browsers.")).toBeVisible();
    expect(within(card).getByRole("button", { name: "Link to this account" })).toBeVisible();
    expect(within(card).getByRole("button", { name: "Use a different account" })).toBeVisible();
    return card;
  }
  it("signing in from the invitation shows the confirmation, even though sign-in re-reads access and eligibility meanwhile", async () => {
    const f = await holder();
    const invite = await inviteCard();
    await fireEvent.click(within(invite).getByRole("button", { name: "Sign in" }));
    await screen.findByRole("dialog");
    const gate = f.holdEligibility();
    await enterCode();
    await waitFor(() => expect(f.controller.accountConfirmed).toBe(true));
    await waitFor(() => expect(f.accountRequests.length).toBeGreaterThan(0));
    // The request's own read, the reconcile's re-read and the refresh's re-read are all waiting.
    await waitFor(() => expect(gate.waiting()).toBeGreaterThanOrEqual(2));
    while (gate.waiting() > 0) {
      gate.releaseOne();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    gate.releaseAll();
    const card = await confirmation();
    expect(screen.queryByText(INVITE)).toBeNull();
    expect(screen.queryByRole("region", { name: OFFER })).toBeNull();
    expect(f.linkPurchase).not.toHaveBeenCalled();
    await fireEvent.click(within(card).getByRole("button", { name: "Link to this account" }));
    await waitFor(() => expect(f.linkPurchase).toHaveBeenCalledOnce());
    expect(f.linkPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ intendedAccountId: f.controller.userId, expectedOwnershipRevision: 0 }),
    );
    expect(await screen.findByText(`Still Pro is linked to ${ACCOUNT}.`)).toBeVisible();
  });
  it("signing in from the invitation shows the confirmation even when native refuses the eligibility reads during the reconcile", async () => {
    const f = await compose({ accountAccess: true, initial: "purchased", accountState: "none" });
    const invite = await inviteCard();
    await fireEvent.click(within(invite).getByRole("button", { name: "Sign in" }));
    await screen.findByRole("dialog");
    // Native refuses the read the sign-in's reconcile overlaps and the confirmation's first
    // re-read, then answers (the Mac on 18 Oct: both refused, the link reported "didn't finish").
    f.refuseEligibility(2);
    await enterCode();
    await waitFor(() => expect(f.controller.accountConfirmed).toBe(true));
    const card = await confirmation();
    expect(screen.queryByRole("region", { name: OFFER })).toBeNull();
    expect(f.linkPurchase).not.toHaveBeenCalled();
    await fireEvent.click(within(card).getByRole("button", { name: "Link to this account" }));
    await waitFor(() => expect(f.linkPurchase).toHaveBeenCalledOnce());
    expect(await screen.findByText(`Still Pro is linked to ${ACCOUNT}.`)).toBeVisible();
  });
  it("the session entry's account revision, then the controller's own: the confirmation stays (MAC-85)", async () => {
    const f = await holder();
    const invite = await inviteCard();
    await fireEvent.click(within(invite).getByRole("button", { name: "Sign in" }));
    await screen.findByRole("dialog");
    const release = f.holdSessionEntry();
    await enterCode();
    // The account is published and confirmed at the session entry's revision while the code waits
    // on the settings mirror: the confirmation can appear here, one revision early.
    await waitFor(() => expect(f.controller.accountConfirmed).toBe(true));
    await confirmation();
    await waitFor(() => expect(reportRatingHold).toHaveBeenLastCalledWith("purchase"));
    vi.mocked(reportRatingHold).mockClear();
    // Watch every node the screen adds between the two revisions: neither the offer line nor the
    // invitation may render, even for one frame, and the rating prompt stays held throughout.
    const added: string[] = [];
    const watcher = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) added.push(node.textContent ?? "");
    });
    watcher.observe(document.body, { childList: true, subtree: true, characterData: true });
    const revision = f.controller.accountRevision;
    release();
    await waitFor(() => expect(f.controller.accountRevision).toBe(revision + 1));
    await waitFor(() => expect(f.controller.accountConfirmed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const card = await confirmation();
    watcher.disconnect();
    expect(added.filter((text) => text.includes(OFFER) || text.includes(INVITE))).toEqual([]);
    for (const [flow] of vi.mocked(reportRatingHold).mock.calls) expect(flow).toBe("purchase");
    expect(screen.queryByRole("region", { name: OFFER })).toBeNull();
    expect(f.linkPurchase).not.toHaveBeenCalled();
    await fireEvent.click(within(card).getByRole("button", { name: "Link to this account" }));
    await waitFor(() => expect(f.linkPurchase).toHaveBeenCalledOnce());
    expect(f.linkPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ intendedAccountId: f.controller.userId, expectedOwnershipRevision: 0 }),
    );
    expect(await screen.findByText(`Still Pro is linked to ${ACCOUNT}.`)).toBeVisible();
  });
  it("after Not now, a plain sign-in from the sync card links nothing and offers nothing this visit", async () => {
    // The sync card's Sign in is the invitation's while the line shows (owner, 19 Oct); a plain
    // sign-in exists only after Not now, which also holds the signed-in offer for this visit.
    const f = await holder();
    const invite = await inviteCard();
    await fireEvent.click(within(invite).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByText(INVITE)).toBeNull());
    const sync = document.querySelector('[data-still-card="sync"]') as HTMLElement;
    await fireEvent.click(within(sync).getByRole("button", { name: "Sign in" }));
    await screen.findByRole("dialog");
    await enterCode();
    await waitFor(() => expect(f.controller.accountConfirmed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("region", { name: OFFER })).toBeNull();
    expect(screen.queryByRole("region", { name: "Link Still Pro" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link Still Pro to an account" })).toBeNull();
    expect(f.linkPurchase).not.toHaveBeenCalled();
  });
  it("Not now hides the signed-in link card for this visit and links nothing", async () => {
    const f = await compose({ accountOnly: true, initial: "purchased", accountState: "none" });
    const offer = await screen.findByRole("region", { name: OFFER });
    await fireEvent.click(within(offer).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: OFFER })).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("region", { name: OFFER })).toBeNull();
    expect(screen.queryByRole("region", { name: "Link Still Pro" })).toBeNull();
    expect(f.linkPurchase).not.toHaveBeenCalled();
  });
  it("closing the invitation's sign-in sheet keeps the invitation: the next Sign in renews the request and shows the confirmation", async () => {
    const f = await holder();
    const invite = await inviteCard();
    await fireEvent.click(within(invite).getByRole("button", { name: "Sign in" }));
    const sheet = await screen.findByRole("dialog");
    await fireEvent.click(within(sheet).getByRole("button", { name: STRINGS.auth.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(INVITE)).toBeVisible();
    await fireEvent.click(within(await inviteCard()).getByRole("button", { name: "Sign in" }));
    await screen.findByRole("dialog");
    await enterCode();
    await waitFor(() => expect(f.controller.accountConfirmed).toBe(true));
    await confirmation();
    expect(screen.queryByRole("region", { name: OFFER })).toBeNull();
    expect(f.linkPurchase).not.toHaveBeenCalled();
  });
});

// ISS-0081: on 2.1.1.387 and .392 a Mac that had linked an accountless Apple Still Pro to the
// signed-in account showed "Link Still Pro to your account." again on the next launch (Link ended in
// "Still Pro is linked to …" again: the server answered already_linked). The fixture is the real host
// launching signed in, with the account's reconcile and the native link read naming the account the
// server's signed proof links the right to.
describe("mounted Apple Still Pro already linked to the signed-in account (ISS-0081)", () => {
  const OFFER = "Link Still Pro to your account.";
  const INVITE = "You have Still Pro. Sign in to keep Still Pro with your account.";
  const ACCOUNT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ACCOUNT = "account@still.test";
  const settled = () => new Promise((resolve) => setTimeout(resolve, 30));
  const syncCard = () => document.querySelector('[data-still-card="sync"]') as HTMLElement;
  // ISS-0105 (owner, 21 Oct): "Still Pro User" only when the signed-in account holds Still Pro.
  const DEVICE_TAG = "Still Pro on this device";
  const expectDeviceTag = () => {
    expect(within(syncCard()).getByText(DEVICE_TAG)).toBeVisible();
    expect(within(syncCard()).queryByText("Still Pro User")).toBeNull();
  };
  it("on launch, linked to the signed-in account: the sync card's Still Pro User tag and nothing else", async () => {
    const f = await compose({ accountOnly: true, initial: "purchased", linkedAccount: ACCOUNT_ID });
    await waitFor(() => expect(f.accountRequests.length).toBeGreaterThan(0));
    await settled();
    expect(within(syncCard()).getByText("Still Pro User")).toBeVisible();
    expect(within(syncCard()).queryByText(DEVICE_TAG)).toBeNull();
    expect(screen.queryByRole("region", { name: OFFER })).toBeNull();
    expect(screen.queryByText(INVITE)).toBeNull();
    expect(screen.queryByRole("region", { name: "Link Still Pro" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link Still Pro to an account" })).toBeNull();
    expect(f.linkPurchase).not.toHaveBeenCalled();
  });
  it("linked to another account: the offer shows, Link asks the server once, and the answer is the fact, not a failure (ISS-0104)", async () => {
    // Native holds proofs only for the signed-in account, so it names no one; the server refuses
    // with owned_elsewhere, which the card states without Try again, and the offer is gone.
    const f = await compose({ accountOnly: true, initial: "purchased", accountState: "none" });
    f.linkPurchase.mockResolvedValue({ status: "owned_elsewhere" } as never);
    const offer = await screen.findByRole("region", { name: OFFER });
    await fireEvent.click(within(offer).getByRole("button", { name: "Link" }));
    const card = await screen.findByRole("region", { name: "Link Still Pro" });
    await fireEvent.click(within(card).getByRole("button", { name: "Link to this account" }));
    await waitFor(() => expect(f.linkPurchase).toHaveBeenCalledOnce());
    expect(await screen.findByText("Still Pro works on this device. It's linked to another account.")).toBeVisible();
    expect(screen.queryByText(/sign in with that account/i)).toBeNull();
    expect(screen.queryByText("Linking didn't finish.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await settled();
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
    expect(f.linkPurchase).toHaveBeenCalledOnce();
    // The account signed in here does not hold the purchase: the tag is the device's (ISS-0105).
    expectDeviceTag();
  });
  it("an accountless right, signed in: the offer shows", async () => {
    const f = await compose({ accountOnly: true, initial: "purchased", accountState: "none", linkedAccount: null });
    expect(await screen.findByRole("region", { name: OFFER })).toBeVisible();
    expect(f.linkPurchase).not.toHaveBeenCalled();
    await settled();
    expectDeviceTag();
  });
  it("no Apple purchase read on this device is not proof the account holds Still Pro: on this device (ISS-0105)", async () => {
    // The account holds nothing, the device keeps its own right, and the link read answers null
    // (another Apple ID in the App Store, an unverified or family-shared transaction, a review
    // binding): absence of device evidence never reads as the account's.
    const f = await compose({ accountOnly: true, initial: "purchased", accountState: "none", eligible: false, accountHeldPro: false });
    await waitFor(() => expect(f.accountRequests.length).toBeGreaterThan(0));
    await settled();
    expectDeviceTag();
  });
  it("the account's own verified proof (bought on the web): Still Pro User (ISS-0105)", async () => {
    const f = await compose({ accountOnly: true, initial: "purchased", accountState: "purchased", eligible: false, accountHeldPro: true });
    await waitFor(() => expect(f.accountRequests.length).toBeGreaterThan(0));
    await waitFor(() => expect(within(syncCard()).getByText("Still Pro User")).toBeVisible());
    expect(within(syncCard()).queryByText(DEVICE_TAG)).toBeNull();
  });
  it.each(["pending", "refused"] as const)(
    "after a refund and a rebuy, a %s link read never shows the old answer's Still Pro User (ISS-0105)",
    async (read) => {
      const f = await compose({ accountOnly: true, initial: "purchased", linkedAccount: ACCOUNT_ID });
      await waitFor(() => expect(within(syncCard()).getByText("Still Pro User")).toBeVisible());
      await f.setAccess("locked");
      await settled();
      expect(within(syncCard()).queryByText("Still Pro User")).toBeNull();
      const held = read === "pending" ? f.holdEligibility() : undefined;
      if (read === "refused") f.refuseEligibility(100);
      await f.setAccess("purchased");
      await settled();
      expectDeviceTag();
      held?.releaseAll();
    },
  );
  it("signed out, the device's own purchase reads Still Pro on this device (ISS-0105)", async () => {
    await compose({ accountAccess: true, initial: "purchased", linkedAccount: ACCOUNT_ID });
    await screen.findByText(INVITE);
    await settled();
    expectDeviceTag();
  });
  it("signed out, a linked right keeps the in-card invitation; signing in as its account says it is linked once the proof arrives", async () => {
    const f = await compose({ accountAccess: true, initial: "purchased", linkedAccount: ACCOUNT_ID });
    const invite = (await screen.findByText(INVITE)).closest("section")!;
    await fireEvent.click(within(invite).getByRole("button", { name: "Sign in" }));
    await screen.findByRole("dialog");
    // A brand-new session has no account proof until its reconcile installs it: hold that, so the
    // read that follows sign-in finds none and the confirmation appears first.
    const release = f.holdReconcile();
    const email = await screen.findByRole("textbox", { name: STRINGS.auth.emailLabel });
    await fireEvent.input(email, { target: { value: ACCOUNT } });
    await fireEvent.click(screen.getByRole("button", { name: STRINGS.codeAuth.send }));
    const code = await screen.findByRole("textbox", { name: STRINGS.codeAuth.codeLabel });
    await fireEvent.input(code, { target: { value: "123456" } });
    await fireEvent.click(screen.getByRole("button", { name: STRINGS.codeAuth.verify }));
    await waitFor(() => expect(f.controller.accountConfirmed).toBe(true));
    expect(await screen.findByRole("heading", { name: "Link Still Pro to this account?" })).toBeVisible();
    release();
    expect(await screen.findByText(`Still Pro is linked to ${ACCOUNT}.`)).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Link Still Pro to this account?" })).toBeNull();
    expect(screen.queryByRole("region", { name: OFFER })).toBeNull();
    expect(screen.queryByText(INVITE)).toBeNull();
    expect(f.linkPurchase).not.toHaveBeenCalled();
  });
});
