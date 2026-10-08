import {
  FEATURE_REGISTRY,
  type BenefitAccessSnapshot,
} from "@still/shared-types";
import type {
  NativeBridge,
  NativeLifetimeOffering,
} from "../../native/bridge.js";
import type {
  ApplePurchaseLinkIntent,
  ApplePurchaseLinkResult,
} from "../../sync/apple-session.js";
import type { AppleSettingsProps } from "./apple-settings-presentation.js";
import type { PurchaseViewProps } from "./purchase-presentation.js";

export interface AppleProAccount {
  id: string;
  email: string;
  revision: number;
  confirmed: boolean;
}
export interface AppleProHostDeps {
  bridge: Pick<
    NativeBridge,
    | "available"
    | "proOffering"
    | "purchasePro"
    | "restorePro"
    | "pendingAppRoute"
    | "acknowledgeAppRoute"
  >;
  readAccess(): Promise<BenefitAccessSnapshot>;
  /** Verifies and atomically installs signed local rights, then returns the current accepted
   * authority snapshot. A generic access read cannot fulfill this port. */
  verifyLocalPurchase(): Promise<BenefitAccessSnapshot>;
  /** Fresh native account-only reconciliation; independent of StoreKit and local linking. */
  refreshAccountAccess?(): Promise<BenefitAccessSnapshot>;
  account(): AppleProAccount | null;
  ownershipRevision(): number;
  /** Current native purchaser-only signed local provenance. Missing port holds linking closed. */
  readLinkEligibility?(): Promise<{
    readonly ownershipRevision: number;
  } | null>;
  linkPurchase(
    intent: ApplePurchaseLinkIntent,
  ): Promise<ApplePurchaseLinkResult>;
  signIn(): void;
  chooseOtherAccount(): Promise<void>;
  publish(): void;
  operationId?(): string;
}
export function appleProOwnership(
  access: BenefitAccessSnapshot,
): "none" | "owned" | "checking" | "verify" {
  const states = FEATURE_REGISTRY.filter((row) => row.tier === "pro").map(
    (row) => access.states[row.id],
  );
  if (states.includes("checking")) return "checking";
  if (states.includes("verification_required")) return "verify";
  if (states.includes("purchased") || states.includes("protected"))
    return "owned";
  return states.includes("locked") ? "none" : "verify";
}

/** Thin host state for the shared D18/D24/D25 screens. Store feedback never establishes rights. */
export function createAppleProHost(deps: AppleProHostDeps) {
  let stopped = false;
  let epoch = 0;
  let accessEpoch = 0;
  let eligibilityEpoch = 0;
  let eligiblePurchase: { readonly ownershipRevision: number } | null = null;
  let busy = false;
  let opening = false;
  let offer: NativeLifetimeOffering | null = null;
  let access: BenefitAccessSnapshot | null = null;
  let purchase: PurchaseViewProps["purchase"] = { state: "idle" };
  let restore: AppleSettingsProps["restore"];
  let link: AppleSettingsProps["link"];
  let linkAccount: AppleProAccount | null = null;
  let linkingRequested = false;
  let linkGeneration = 0;
  let pendingKind: "buy" | "restore" | undefined;
  const changed = () => {
    if (!stopped) deps.publish();
  };
  const sameAccount = (a: AppleProAccount) => {
    const current = deps.account();
    return (
      current?.id === a.id &&
      current.revision === a.revision &&
      current.email === a.email &&
      current.confirmed
    );
  };
  const owner = () => (access ? appleProOwnership(access) : "checking");
  function clearLink() {
    linkGeneration++;
    link = undefined;
    linkAccount = null;
    linkingRequested = false;
  }
  async function refreshLinkEligibility() {
    const ticket = ++eligibilityEpoch;
    const observed = accessEpoch;
    eligiblePurchase = null;
    if (stopped || owner() !== "owned") return;
    try {
      const result = await deps.readLinkEligibility?.();
      if (stopped || ticket !== eligibilityEpoch || observed !== accessEpoch)
        return;
      eligiblePurchase =
        result &&
        Number.isSafeInteger(result.ownershipRevision) &&
        result.ownershipRevision >= 0
          ? result
          : null;
    } catch {
      /* An unknown native purchaser never offers linking. */
    }
    if (stopped || ticket !== eligibilityEpoch || observed !== accessEpoch)
      return;
    if (!eligiblePurchase) clearLink();
    changed();
  }
  function observeAccess(snapshot: BenefitAccessSnapshot) {
    if (stopped) return;
    accessEpoch++;
    access = snapshot;
    if (owner() !== "owned") clearLink();
    void refreshLinkEligibility();
    changed();
  }
  async function refresh() {
    if (stopped || busy) return;
    const generation = ++epoch;
    const observed = accessEpoch;
    const [rights, offering] = await Promise.allSettled([
      pendingKind ? deps.verifyLocalPurchase() :
        deps.account()?.confirmed && deps.refreshAccountAccess ? deps.refreshAccountAccess() : deps.readAccess(),
      deps.bridge.proOffering(),
    ]);
    if (stopped || generation !== epoch) return;
    if (observed === accessEpoch)
      access = rights.status === "fulfilled" ? rights.value : access;
    offer = offering.status === "fulfilled" ? offering.value : null;
    // Successful signed installation alone cannot publish an older result over newer access.
    // The existing authority returns its accepted snapshot, including its own publication.
    if (
      pendingKind &&
      rights.status === "fulfilled" &&
      access === rights.value &&
      appleProOwnership(rights.value) === "owned"
    ) {
      purchase =
        pendingKind === "buy"
          ? { state: "success", confirmed: true }
          : { state: "idle" };
      restore = pendingKind === "restore" ? { state: "restored" } : undefined;
      pendingKind = undefined;
    }
    await refreshLinkEligibility();
    changed();
  }
  async function transact(kind: "buy" | "restore") {
    if (
      stopped ||
      busy ||
      !deps.bridge.available ||
      (kind === "buy" &&
        (purchase.state === "pending" || pendingKind !== undefined))
    )
      return;
    // Re-read before charge: stale handles cannot offer a duplicate purchase.
    busy = true;
    const generation = ++epoch;
    let verifyingLocal = false;
    purchase = kind === "buy" ? { state: "pending" } : { state: "idle" };
    restore = kind === "restore" ? { state: "checking" } : undefined;
    changed();
    try {
      const observed = accessEpoch;
      const account = deps.account();
      if (kind === "buy" && account && !account.confirmed && deps.refreshAccountAccess)
        throw new Error("Current account requires verification before purchase");
      const accountCheck = account?.confirmed && deps.refreshAccountAccess;
      let accountUnknown = Boolean(account && deps.refreshAccountAccess && !account.confirmed);
      const read = accountCheck
        ? await deps.refreshAccountAccess!().catch(error => {
            if (kind === "buy") throw error;
            accountUnknown = true;
            return deps.readAccess();
          })
        : await deps.readAccess();
      if (stopped || generation !== epoch) return;
      if (observed === accessEpoch) access = read;
      if (kind === "buy" && owner() !== "none") {
        purchase = { state: "idle" };
        return;
      }
      if (kind === "restore" && accountCheck && !accountUnknown && owner() === "owned") {
        restore = { state: "restored" };
        purchase = { state: "idle" };
        return;
      }
      const acquisition = accessEpoch;
      const fresh = kind === "buy" ? await deps.bridge.proOffering() : null;
      if (stopped || generation !== epoch) return;
      if (
        kind === "buy" &&
        (acquisition !== accessEpoch || owner() !== "none")
      ) {
        purchase = { state: "idle" };
        return;
      }
      if (
        kind === "buy" &&
        (!fresh || !offer || JSON.stringify(fresh) !== JSON.stringify(offer))
      ) {
        offer = fresh;
        purchase = { state: "failed" };
        return;
      }
      const result =
        kind === "buy"
          ? await deps.bridge.purchasePro(fresh!)
          : await deps.bridge.restorePro();
      if (stopped || generation !== epoch) return;
      if (result.outcome === "cancelled") {
        purchase = { state: "idle" };
        restore = undefined;
        return;
      }
      if (
        result.outcome === "nothing" &&
        result.receipt === "verifiedNotEntitled"
      ) {
        // A conclusive native Restore cannot remove unrelated account/protected rights.
        restore = accountUnknown
          ? { state: "verify", onAction: () => void transact("restore") } : { state: "nothing" };
        purchase = { state: "idle" };
        return;
      }
      if (
        result.outcome === "purchased" ||
        result.outcome === "restored" ||
        result.outcome === "pending"
      ) {
        pendingKind = kind;
        verifyingLocal = true;
        const verifying = accessEpoch;
        const verified = await deps.verifyLocalPurchase();
        if (stopped || generation !== epoch) return;
        if (verifying === accessEpoch) access = verified;
        if (access === verified && appleProOwnership(verified) === "owned") {
          pendingKind = undefined;
          purchase =
            kind === "buy"
              ? { state: "success", confirmed: true }
              : { state: "idle" };
          restore = kind === "restore" ? { state: "restored" } : undefined;
        } else {
          purchase = { state: "pending" };
          restore = undefined;
        }
        return;
      }
      if (result.outcome === "nothing") {
        restore = pendingKind
          ? undefined
          : { state: "verify", onAction: () => void transact("restore") };
        return;
      }
      throw new Error("Native purchase did not complete");
    } catch {
      if (stopped || generation !== epoch) return;
      purchase = { state: "failed" };
      if (kind === "restore")
        // Keep fresh native Restore failures distinct from this call's signed verifier.
        restore = verifyingLocal
          ? undefined
          : { state: "failed", onAction: () => void transact("restore") };
    } finally {
      if (generation === epoch) {
        busy = false;
        void refreshLinkEligibility();
        changed();
      }
    }
  }
  async function requestLink() {
    if (stopped || busy || owner() !== "owned" || !eligiblePurchase) return;
    const generation = ++linkGeneration;
    const before = deps.account();
    await refreshLinkEligibility();
    if (
      stopped ||
      busy ||
      generation !== linkGeneration ||
      owner() !== "owned" ||
      !eligiblePurchase ||
      before?.id !== deps.account()?.id ||
      before?.revision !== deps.account()?.revision
    )
      return;
    linkingRequested = true;
    const account = deps.account();
    if (!account?.confirmed) {
      deps.signIn();
      return;
    }
    linkAccount = { ...account };
    const target = linkAccount;
    link = {
      state: "confirm",
      email: target.email,
      onConfirm: () => void confirmLink(target, generation),
      onChooseOther: () => {
        if (
          !stopped &&
          !busy &&
          generation === linkGeneration &&
          sameAccount(target)
        )
          void chooseOther();
      },
    };
    changed();
  }
  async function chooseOther() {
    linkGeneration++;
    link = undefined;
    linkAccount = null;
    changed();
    await deps.chooseOtherAccount();
    if (!stopped) deps.signIn();
  }
  async function confirmLink(account: AppleProAccount, generation: number) {
    if (
      stopped ||
      busy ||
      generation !== linkGeneration ||
      !linkAccount ||
      !sameAccount(account) ||
      owner() !== "owned"
    )
      return;
    const operation = ++epoch;
    busy = true;
    link = { state: "pending", email: account.email };
    changed();
    try {
      const observed = accessEpoch;
      const eligible = await deps.readLinkEligibility?.();
      if (
        stopped ||
        generation !== linkGeneration ||
        !sameAccount(account) ||
        owner() !== "owned"
      )
        return;
      if (observed !== accessEpoch)
        throw new Error("Local Apple purchaser changed during confirmation");
      if (
        !eligible ||
        !Number.isSafeInteger(eligible.ownershipRevision) ||
        eligible.ownershipRevision < 0
      )
        throw new Error("Local Apple purchaser requires verification");
      const result = await deps.linkPurchase({
        intendedAccountId: account.id,
        expectedOwnershipRevision: eligible.ownershipRevision,
        operationId: deps.operationId?.() ?? crypto.randomUUID(),
      });
      if (stopped || generation !== linkGeneration || !sameAccount(account))
        return;
      link =
        result.status === "linked" || result.status === "already_linked"
          ? { state: "linked", email: account.email }
          : { state: "failed", email: account.email, onRetry: requestLink };
      // Link failure does not touch the independent local proof lane.
    } catch {
      if (!stopped && generation === linkGeneration && sameAccount(account))
        link = { state: "failed", email: account.email, onRetry: requestLink };
    } finally {
      if (operation === epoch) {
        busy = false;
        changed();
      }
    }
  }
  return {
    refresh,
    observeAccess,
    show() {
      opening = true;
      changed();
      void refresh();
    },
    close() {
      opening = false;
      changed();
    },
    accountChanged() {
      epoch++;
      busy = false;
      if (linkAccount && !sameAccount(linkAccount)) {
        linkGeneration++;
        link = undefined;
        linkAccount = null;
        linkingRequested = false;
      }
      if (linkingRequested && !linkAccount && deps.account()?.confirmed)
        requestLink();
      if (deps.account()?.confirmed && deps.refreshAccountAccess) void refresh();
      changed();
    },
    async route() {
      const route = await deps.bridge.pendingAppRoute();
      if (stopped || !route) return;
      opening = true;
      changed();
      // Acknowledge only after the current host accepted the represented destination.
      await deps.bridge.acknowledgeAppRoute(route.revision);
      await refresh();
    },
    props(
      controls: PurchaseViewProps["controls"],
    ): Extract<PurchaseViewProps, { host: "apple" }> {
      const ownership = owner();
      return {
        host: "apple",
        controls,
        access: { state: ownership, verified: access !== null },
        channel: offer && deps.bridge.available ? "ready" : "unavailable",
        ...(offer ? { offer: { price: offer.price, verified: true } } : {}),
        purchase: {
          ...purchase,
          ...(pendingKind !== undefined ? { verificationRequired: true } : {}),
        },
        ...(restore
          ? {
              restore: {
                ...restore,
                verified: true,
                conclusive: ["restored", "nothing"].includes(restore.state),
              },
            }
          : {}),
        native: {
          verified: deps.bridge.available,
          onBuy: () => void transact("buy"),
          onRestore: () => void transact("restore"),
          ...(!busy ? { onVerify: () => void refresh() } : {}),
        },
        onBack: () => {
          opening = false;
          changed();
        },
      };
    },
    settings(): Pick<AppleSettingsProps, "pro" | "restore" | "link"> {
      return {
        pro: {
          ownership: owner(),
          channel: offer && deps.bridge.available ? "ready" : "unavailable",
          ...(offer
            ? {
                offer: {
                  price: offer.price,
                  priceNote: "One-time purchase. Lifetime access.",
                  refundNote: "Apple purchases follow Apple's refund process.",
                },
              }
            : {}),
          state: purchase.state,
          ...(pendingKind !== undefined ? { verificationRequired: true } : {}),
          onBuy: () => {
            opening = true;
            changed();
          },
          onRestore: () => void transact("restore"),
          onRetry: () => (pendingKind ? void refresh() : void transact("buy")),
        },
        restore,
        link,
      };
    },
    requestLink,
    get open() {
      return opening;
    },
    get canLink() {
      return !busy && owner() === "owned" && eligiblePurchase !== null && !link;
    },
    stop() {
      stopped = true;
      epoch++;
      accessEpoch++;
      eligibilityEpoch++;
    },
  };
}
export type AppleProHost = ReturnType<typeof createAppleProHost>;
