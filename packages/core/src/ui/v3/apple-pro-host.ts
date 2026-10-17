import {
  FEATURE_REGISTRY,
  type BenefitAccessSnapshot,
} from "@still/shared-types";
import type {
  NativeBridge,
  NativeAppRoute,
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
  /** Whether this build can sign in. Present and true, a signed-out Get Still Pro asks for
   * sign-in first (ISS-0071, ADR 0005); absent or false, it goes straight to Apple as before. */
  canSignIn?(): boolean;
  /** Whether a session exists, even before its address is known. Absent, `account()` decides. */
  signedIn?(): boolean;
  chooseOtherAccount(): Promise<void>;
  publish(): void;
  operationId?(): string;
}
/** The two lines the sign-in sheet adds when Get Still Pro opened it (ISS-0071, option B). */
export const APPLE_PURCHASE_SIGN_IN_COPY = {
  note: "Sign in first, so Still Pro stays with your account.",
  skip: "Buy without an account",
} as const;

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
  // ISS-0071: Get Still Pro asked a signed-out person to sign in first. A confirmed sign-in
  // continues the purchase; cancelling, skipping or leaving the screen drops it.
  let purchaseSignIn = false;
  // The purchase that sign-in continued, until it reaches Apple. An account update before then
  // (the session settling) cancels that preflight; the continuation is re-armed, not lost.
  let signInContinuation: number | undefined;
  // The account that signed in for this purchase. A re-armed continuation belongs to it alone,
  // and is re-armed at most once per Get Still Pro.
  let continuationAccount: string | null = null;
  let purchaseSignInAccount: string | null = null;
  let continuationRearmed = false;
  let preflightGeneration: number | undefined;
  let nativeAcquisitionGeneration: number | undefined;
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
    // A link already in flight rereads eligibility itself and ends in linked or failed (with
    // Try again); an overlapping refresh must not cancel it silently.
    if (!eligiblePurchase && link?.state !== "pending") clearLink();
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
  async function transact(kind: "buy" | "restore", fromSignIn = false) {
    if (
      stopped ||
      busy ||
      nativeAcquisitionGeneration !== undefined ||
      !deps.bridge.available ||
      (kind === "buy" &&
        (purchase.state === "pending" || pendingKind !== undefined))
    )
      return;
    // Re-read before charge: stale handles cannot offer a duplicate purchase.
    busy = true;
    const generation = ++epoch;
    preflightGeneration = generation;
    signInContinuation = fromSignIn ? generation : undefined;
    let verifyingLocal = false;
    // A purchase started signed in links to that account once it is verified (ISS-0071).
    let linkTo: AppleProAccount | null = null;
    purchase = kind === "buy" ? { state: "pending" } : { state: "idle" };
    restore = kind === "restore" ? { state: "checking" } : undefined;
    changed();
    try {
      const observed = accessEpoch;
      const account = deps.account();
      const buyer = kind === "buy" && account?.confirmed ? { ...account } : null;
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
        // Nothing was dispatched: this Buy never reached the App Store.
        purchase = { state: "failed", notCharged: true };
        return;
      }
      preflightGeneration = undefined;
      signInContinuation = undefined;
      nativeAcquisitionGeneration = generation;
      const result =
        kind === "buy"
          ? await deps.bridge.purchasePro(fresh!)
          : await deps.bridge.restorePro();
      if (nativeAcquisitionGeneration === generation)
        nativeAcquisitionGeneration = undefined;
      if (stopped) return;
      if (generation !== epoch) {
        // Account replacement cannot discard a dispatched StoreKit completion. Retain
        // only its recovery intent; a current signed read must establish the rights.
        if (result.outcome === "cancelled" && pendingKind === undefined) {
          purchase = { state: "idle" };
          restore = undefined;
        } else if (result.outcome === "unavailable" && pendingKind === undefined) {
          // The native port refused dispatch; unlike failed/noSignal this is not a
          // lost or malformed reply from an acquisition that may have completed.
          purchase = kind === "buy" ? { state: "failed", notCharged: true } : { state: "failed" };
          restore = kind === "restore"
            ? { state: "failed", onAction: () => void transact("restore") } : undefined;
        } else if (result.outcome === "nothing" &&
          result.receipt === "verifiedNotEntitled" && pendingKind === undefined) {
          purchase = { state: "idle" };
          // Local absence cannot conclude ownership for the replacement account.
          restore = { state: "verify", onAction: () => void transact("restore") };
        } else {
          pendingKind ??= kind;
          purchase = { state: "pending" };
          restore = undefined;
        }
        changed();
        return;
      }
      if (result.outcome === "cancelled") {
        purchase = { state: "idle" };
        restore = undefined;
        return;
      }
      if (result.outcome === "unavailable" && kind === "buy" && pendingKind === undefined) {
        // Native "unavailable" is refused before any charge (paid tier off, changed offer, sales
        // policy or the unverified sandbox installation check, e.g. no App Store account), so
        // the copy must not suggest a purchase happened (ISS-0070).
        purchase = { state: "failed", notCharged: true };
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
          linkTo = buyer;
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
      if (nativeAcquisitionGeneration === generation) {
        nativeAcquisitionGeneration = undefined;
        if (!stopped && generation !== epoch) {
          // An interrupted native response is an unknown acquisition, never a reason
          // to charge again. Current local verification supplies the recovery path.
          pendingKind ??= kind;
          purchase = { state: "pending" };
          restore = undefined;
          changed();
        }
      }
      if (stopped || generation !== epoch) return;
      purchase = { state: "failed" };
      if (kind === "restore")
        // Keep fresh native Restore failures distinct from this call's signed verifier.
        restore = verifyingLocal
          ? undefined
          : { state: "failed", onAction: () => void transact("restore") };
    } finally {
      if (generation === epoch) {
        preflightGeneration = undefined;
        if (signInContinuation === generation) signInContinuation = undefined;
        busy = false;
        if (linkTo) void linkPurchased(linkTo);
        else void refreshLinkEligibility();
        changed();
      }
    }
  }
  /** Get Still Pro: signed out on a build that can sign in, ask for sign-in first (ISS-0071). */
  function buy() {
    if (stopped) return;
    const signedOut = deps.signedIn ? !deps.signedIn() : !deps.account();
    if (signedOut && deps.canSignIn?.()) {
      purchaseSignIn = true;
      purchaseSignInAccount = null;
      continuationRearmed = false;
      changed();
      deps.signIn();
      return;
    }
    void transact("buy");
  }
  /** A purchase started signed in, now verified on this device: link it to that same account
   * through the existing guarded link (same account and session, a purchaser this device can
   * prove, the ownership revision it read). Any mismatch leaves Still Pro on this device only. */
  async function linkPurchased(account: AppleProAccount) {
    if (
      stopped ||
      busy ||
      (link && link.state !== "failed") ||
      owner() !== "owned" ||
      !sameAccount(account)
    )
      return;
    const generation = ++linkGeneration;
    linkAccount = { ...account };
    // Eligibility is read inside the guarded link (once more if an overlapping refresh changed
    // access meanwhile); anything it cannot prove ends in the failed card with Try again.
    await confirmLink(linkAccount, generation, () => void linkPurchased(account), 2);
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
  async function confirmLink(
    account: AppleProAccount,
    generation: number,
    onRetry: () => void = requestLink,
    attempts = 1,
  ) {
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
      let eligible: { readonly ownershipRevision: number } | null | undefined;
      for (let attempt = 1; ; attempt++) {
        const observed = accessEpoch;
        eligible = await deps.readLinkEligibility?.();
        if (
          stopped ||
          generation !== linkGeneration ||
          !sameAccount(account) ||
          owner() !== "owned"
        )
          return;
        const proven =
          eligible &&
          Number.isSafeInteger(eligible.ownershipRevision) &&
          eligible.ownershipRevision >= 0;
        if (observed === accessEpoch && proven) break;
        if (attempt >= attempts)
          throw new Error(
            observed !== accessEpoch
              ? "Local Apple purchaser changed during confirmation"
              : "Local Apple purchaser requires verification",
          );
      }
      const result = await deps.linkPurchase({
        intendedAccountId: account.id,
        expectedOwnershipRevision: eligible!.ownershipRevision,
        operationId: deps.operationId?.() ?? crypto.randomUUID(),
      });
      if (stopped || generation !== linkGeneration || !sameAccount(account))
        return;
      link =
        result.status === "linked" || result.status === "already_linked"
          ? { state: "linked", email: account.email }
          : { state: "failed", email: account.email, onRetry };
      // Link failure does not touch the independent local proof lane.
    } catch {
      if (!stopped && generation === linkGeneration && sameAccount(account))
        link = { state: "failed", email: account.email, onRetry };
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
      purchaseSignIn = false;
      changed();
    },
    accountChanged() {
      // Cancel only checks that have not reached native purchase/Restore. A dispatched
      // purchase still needs its independent signed-rights recovery, never another charge.
      if (preflightGeneration === epoch) {
        // Re-arm the sign-in continuation once, and only for the account that signed in for it:
        // a sign-out or another account drops it, so a later sign-in never opens Apple's sheet.
        if (
          signInContinuation === preflightGeneration &&
          !continuationRearmed &&
          continuationAccount !== null &&
          deps.account()?.id === continuationAccount
        ) {
          purchaseSignIn = true;
          purchaseSignInAccount = continuationAccount;
          continuationRearmed = true;
        }
        signInContinuation = undefined;
        preflightGeneration = undefined;
        if (pendingKind === undefined) {
          purchase = { state: "idle" };
          restore = undefined;
        }
      }
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
      const current = deps.account();
      if (
        purchaseSignIn &&
        purchaseSignInAccount !== null &&
        current?.id !== purchaseSignInAccount
      ) {
        purchaseSignIn = false;
        purchaseSignInAccount = null;
      }
      if (purchaseSignIn && current?.confirmed) {
        // Signed in from Get Still Pro: continue to Apple's sheet without a second tap. The
        // purchase's own fresh account check replaces the ordinary refresh.
        purchaseSignIn = false;
        purchaseSignInAccount = null;
        continuationAccount = current.id;
        void transact("buy", true);
      } else if (deps.account()?.confirmed && deps.refreshAccountAccess) void refresh();
      changed();
    },
    /** Takes a pending still://pro. `pending` is the route the app router already read once
     * (createAppleAppRoutes); without it this reads the pending route itself. */
    async route(pending?: NativeAppRoute) {
      const route = pending ?? (await deps.bridge.pendingAppRoute());
      // still://sync belongs to the sync route (apple-sync-route); leave it pending for it.
      if (stopped || !route || route.route !== "pro") return;
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
          onBuy: buy,
          onRestore: () => void transact("restore"),
          ...(!busy ? { onVerify: () => void refresh() } : {}),
        },
        onBack: () => {
          opening = false;
          purchaseSignIn = false;
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
                },
              }
            : {}),
          state: purchase.state,
          ...(pendingKind !== undefined ? { verificationRequired: true } : {}),
          ...(purchase.notCharged ? { notCharged: true } : {}),
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
    /** The sign-in sheet was closed without signing in: nothing is bought. */
    signInDismissed() {
      if (!purchaseSignIn) return;
      purchaseSignIn = false;
      purchaseSignInAccount = null;
      changed();
    },
    /** "Buy without an account": Apple's sheet, exactly as an accountless purchase always was. */
    buyWithoutAccount() {
      if (stopped || !purchaseSignIn) return;
      purchaseSignIn = false;
      changed();
      void transact("buy");
    },
    /** True while the sign-in sheet is open because Get Still Pro asked for it. */
    get signInForPurchase() {
      return purchaseSignIn;
    },
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
