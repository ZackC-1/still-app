import type { ApplePurchaseAnalytics } from "../../analytics/apple-purchase-analytics.js";
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
import { proPurchased } from "./presentation.js";
import type { UiAnalytics } from "../controller.svelte.js";

export interface AppleProAccount {
  id: string;
  email: string;
  revision: number;
  confirmed: boolean;
}
export interface AppleProHostDeps {
  /** Consent and device identity remain owned by the existing app analytics client. */
  analytics?: Pick<UiAnalytics, "track">;
  purchaseAnalytics?: Pick<ApplePurchaseAnalytics, "begin">;
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
  /** Current native purchaser-only signed local provenance. Missing port holds linking closed.
   * `linkedAccount` names the account a current server-signed account proof links the right to
   * (native's verified, bound account); absent or null, nothing on this device says so. */
  readLinkEligibility?(): Promise<{
    readonly ownershipRevision: number;
    readonly linkedAccount?: string | null;
  } | null>;
  /** ISS-0105: positive provenance that this account itself holds Still Pro (a verified account
   * proof for it in native's record). Absent, or false, the tag stays "Still Pro on this device"
   * unless native's proof links this device's purchase to the account. Display only. */
  readAccountHeldPro?(accountId: string): Promise<boolean>;
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
  /** ISS-0104: keeps the server's "owned_elsewhere" answers (account id to purchaser revision)
   * across launches, so a relaunch states the fact instead of offering Link again. Absent, the
   * memory lasts the process. A read that throws or returns junk counts as empty. */
  heldElsewhereMemory?: {
    read(): string | null | undefined;
    write(value: string): void;
  };
}
/** The two lines the sign-in sheet adds when Get Still Pro opened it (ISS-0071, option B). */
export const APPLE_PURCHASE_SIGN_IN_COPY = {
  // Owner (19 Oct, ISS-0085): the purchase-opened sheet says what it is for. The sync-opened
  // sheet keeps STRINGS.auth.
  title: "Sign in to purchase Still Pro",
  prompt: "Enter your email to get a 6-digit code.",
  note: "Sign in before purchase to associate Still Pro with your account.",
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
/** ISS-0104: the remembered "owned_elsewhere" answers, account id to purchaser revision. Anything
 * unreadable (a thrown read, non-JSON, a non-object, a non-number) is treated as empty. */
function readHeldElsewhere(
  memory: AppleProHostDeps["heldElsewhereMemory"],
): Map<string, number> {
  const held = new Map<string, number>();
  try {
    const raw = memory?.read();
    if (typeof raw !== "string") return held;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return held;
    for (const [account, revision] of Object.entries(parsed))
      if (typeof revision === "number" && Number.isFinite(revision)) held.set(account, revision);
  } catch {
    // Unreadable memory is empty memory.
  }
  return held;
}
export function createAppleProHost(deps: AppleProHostDeps) {
  let stopped = false;
  let epoch = 0;
  let accessEpoch = 0;
  let eligibilityEpoch = 0;
  let eligiblePurchase: {
    readonly ownershipRevision: number;
    readonly linkedAccount: string | null;
  } | null = null;
  // ISS-0105: `eligiblePurchase` is this access observation's own settled answer. It goes stale
  // when a read starts or the answer is cleared, so a pending or refused read never shows the
  // account's tag from an older answer (for example across a refund and a rebuy).
  let eligibilityFresh = false;
  // ISS-0105: the account a positive provenance read found holding Still Pro, for one access
  // observation only.
  let accountProvenance: { readonly account: string; readonly access: number } | null = null;
  let provenanceEpoch = 0;
  let busy = false;
  let opening = false;
  let measuredOffer = false;
  let offer: NativeLifetimeOffering | null = null;
  let access: BenefitAccessSnapshot | null = null;
  let purchase: PurchaseViewProps["purchase"] = { state: "idle" };
  let restore: AppleSettingsProps["restore"];
  let link: AppleSettingsProps["link"];
  let linkAccount: AppleProAccount | null = null;
  // ISS-0076: a deliberate link request (the invitation's Sign in, the link card's Link) stays
  // requested across the re-checks that sign-in starts: the account reconcile republishes access,
  // the cache holds rows while a refresh is in flight, and every snapshot re-reads link eligibility.
  // Only a conclusive answer (nothing owned, nothing eligible, the sheet closed signed out, another
  // account) drops it; a settled eligible answer re-offers the confirmation.
  let linkingRequested = false;
  let linkSignInAsked = false;
  // ISS-0076 (MAC-85): the request opened sign-in. That sign-in settles over more than one account
  // revision (the session entry's, then the controller's own), each re-reading the confirmation.
  let linkViaSignIn = false;
  let requestingLink = false;
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
  const track: UiAnalytics["track"] = (name, props) => {
    try { deps.analytics?.track(name, props); } catch { /* Analytics never controls purchase UI. */ }
  };
  function closeOffer() {
    if (measuredOffer) {
      measuredOffer = false;
      track("paywall_dismissed", { trigger: "upgrade_button", where: "app" });
    }
    opening = false;
    purchaseSignIn = false;
    changed();
  }
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
  /** ISS-0081: the last settled read says the server's signed account proof already links this
   * purchase to the account signed in here, so there is nothing to offer. The server stays the
   * authority (native reads its proof for the account it verified); the shown account only has to
   * agree, so a mismatch or a sign-out keeps today's offer and the server decides on Link. */
  const linkedHere = () => {
    const holder = eligiblePurchase?.linkedAccount;
    return typeof holder === "string" && holder === deps.account()?.id;
  };
  /** ISS-0104: the purchase is linked to a different account, so there is nothing to offer this
   * one and the card says so instead of asking. Native names such an account only when it holds
   * a proof for it (it never holds another account's proofs), so in practice this is the server's
   * own "owned_elsewhere" answer to a link from this account at this purchaser revision. A sign-in
   * as another account, a new revision (the holder moved it) or a proof naming this account ends it.
   * No transfer screen this release (owner, 20 Oct): the holder's own sign-in is how it moves. */
  const heldElsewhere = readHeldElsewhere(deps.heldElsewhereMemory);
  const writeHeldElsewhere = () => {
    try {
      deps.heldElsewhereMemory?.write(JSON.stringify(Object.fromEntries(heldElsewhere)));
    } catch {
      // A refused write keeps the process memory only.
    }
  };
  const rememberHeldElsewhere = (account: string, revision: number) => {
    heldElsewhere.set(account, revision);
    writeHeldElsewhere();
  };
  /** An answer that disproves the memory for this account (native's proof names it, or a link
   * went through) drops its entry, so the memory holds only accounts still refused. */
  const forgetHeldElsewhere = (account: string) => {
    if (heldElsewhere.delete(account)) writeHeldElsewhere();
  };
  const linkedElsewhere = () => {
    const current = deps.account();
    if (!current || !eligiblePurchase) return false;
    const holder = eligiblePurchase.linkedAccount;
    // Native's own proof decides first, either way: it names this account, so nothing is held
    // elsewhere whatever the memory says; it names another, so it is.
    if (typeof holder === "string") return holder !== current.id;
    return heldElsewhere.get(current.id) === eligiblePurchase.ownershipRevision;
  };
  const elsewhereCard = (account: AppleProAccount) => ({ state: "elsewhere" as const, email: account.email });
  /** ISS-0076 (MAC-85): a confirmation kept on screen, without its buttons, while the sign-in that
   * the request opened settles at a newer account revision. It holds the place (no offer card, no
   * second sign-in, the rating hold stays) until a fresh confirmation replaces it. */
  const fencedConfirm = () => link?.state === "confirm" && !link.onConfirm;
  function clearLink() {
    linkGeneration++;
    link = undefined;
    linkAccount = null;
    linkingRequested = false;
    linkSignInAsked = false;
    linkViaSignIn = false;
  }
  /** Re-read the native purchaser provenance behind the link affordance. The last settled answer
   * stays in place while a read is in flight, while access is being re-checked, or when native
   * refuses the read (it does while the account reconcile that sign-in starts is in flight), so
   * the affordance neither blinks off nor loses a request; a settled answer replaces it, and a
   * settled eligible one offers a requested link (`offer`, off only for the request's own read). */
  async function refreshLinkEligibility(offer = true) {
    const ticket = ++eligibilityEpoch;
    const observed = accessEpoch;
    eligibilityFresh = false;
    void refreshAccountProvenance();
    if (stopped || owner() !== "owned") return;
    let next: typeof eligiblePurchase;
    try {
      const result = await deps.readLinkEligibility?.();
      if (stopped || ticket !== eligibilityEpoch || observed !== accessEpoch)
        return;
      next =
        result &&
        Number.isSafeInteger(result.ownershipRevision) &&
        result.ownershipRevision >= 0
          ? {
              ownershipRevision: result.ownershipRevision,
              linkedAccount:
                typeof result.linkedAccount === "string"
                  ? result.linkedAccount
                  : null,
            }
          : null;
    } catch {
      // A refused read is no answer: the next snapshot or refresh asks again. Only a settled
      // "no purchaser" below withdraws the affordance and a requested link. The last settled answer
      // still stands, and it keeps the affordance on, so it also offers a requested link (MAC-85:
      // otherwise the offer card shows instead of the confirmation when every later read is refused).
      if (offer && !stopped && ticket === eligibilityEpoch && observed === accessEpoch)
        offerRequestedLink();
      return;
    }
    if (stopped || ticket !== eligibilityEpoch || observed !== accessEpoch)
      return;
    eligiblePurchase = next;
    eligibilityFresh = true;
    // A link already in flight rereads eligibility itself and ends in linked or failed (with
    // Try again); an overlapping refresh must not cancel it silently.
    if (!eligiblePurchase && link?.state !== "pending") clearLink();
    // ISS-0081: a new session starts with no account proofs, so the read right after sign-in can
    // offer the confirmation before the reconcile installs the proof. Once it says this account
    // already holds the purchase, the confirmation becomes the linked status (and its old Link
    // tap is fenced) instead of asking to link it again.
    if (
      linkedHere() &&
      link?.state === "confirm" &&
      linkAccount &&
      sameAccount(linkAccount)
    ) {
      linkGeneration++;
      linkingRequested = false;
      linkSignInAsked = false;
      link = { state: "linked", email: linkAccount.email };
    }
    // ISS-0104: linked to a different account: a pending confirmation is withdrawn and the card
    // says where the purchase is; nothing is offered until the account or the revision changes.
    // Once it is no longer held elsewhere (the holder moved it, or native's proof now names this
    // account) the card leaves; linked here offers nothing, anything else offers as usual.
    const current = deps.account();
    if (current && linkedHere()) forgetHeldElsewhere(current.id);
    if (current?.confirmed && linkedElsewhere() && (!link || link.state === "confirm")) {
      linkGeneration++;
      linkingRequested = false;
      linkSignInAsked = false;
      linkAccount = { ...current };
      link = elsewhereCard(current);
    } else if (link?.state === "elsewhere" && !linkedElsewhere()) {
      clearLink();
    }
    changed();
    if (offer) offerRequestedLink();
  }
  /** ISS-0105: re-read whether the signed-in account itself holds Still Pro, for the current
   * access observation. Cleared first; only a positive answer for the same account and observation
   * stands. */
  async function refreshAccountProvenance() {
    const ticket = ++provenanceEpoch;
    const observed = accessEpoch;
    accountProvenance = null;
    const account = deps.account();
    if (stopped || !account?.confirmed || !deps.readAccountHeldPro) return;
    const held = await deps.readAccountHeldPro(account.id).then(
      (answer) => answer === true,
      () => false,
    );
    if (stopped || ticket !== provenanceEpoch || observed !== accessEpoch || deps.account()?.id !== account.id) return;
    if (!held) return;
    accountProvenance = { account: account.id, access: observed };
    changed();
  }
  /** A requested link whose sign-in has confirmed: show the confirmation as soon as access is
   * owned and the purchaser provenance has settled, whichever of the two lands last. */
  function offerRequestedLink() {
    if (
      stopped ||
      busy ||
      requestingLink ||
      !linkingRequested ||
      (!fencedConfirm() && (link || linkAccount)) ||
      owner() !== "owned" ||
      !eligiblePurchase ||
      !deps.account()?.confirmed
    )
      return;
    void requestLink();
  }
  function observeAccess(snapshot: BenefitAccessSnapshot) {
    if (stopped) return;
    accessEpoch++;
    access = snapshot;
    // Conclusively nothing owned: nothing to link. A re-check in flight ("checking") or a held
    // snapshot ("verify") keeps a requested link and the last eligibility answer for owned access
    // to come back to.
    if (owner() === "none") {
      eligiblePurchase = null;
      eligibilityFresh = false;
      clearLink();
    }
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
    let acquisitionStarted = false;
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
      // Optional preparation has an absolute UI bound and cannot prevent a purchase.
      let purchaseObserved: Awaited<ReturnType<ApplePurchaseAnalytics["begin"]>> = null;
      if (kind === "buy" && deps.purchaseAnalytics) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { purchaseObserved = await Promise.race([deps.purchaseAnalytics.begin(),
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 500); })]); }
        catch { /* Analytics unavailable; purchasing continues. */ }
        finally { clearTimeout(timer); }
      }
      // Analytics preparation is another asynchronous pre-charge boundary.
      if (stopped || generation !== epoch) return;
      if (kind === "buy" && (acquisition !== accessEpoch || owner() !== "none")) {
        purchase = { state: "idle" };
        return;
      }
      preflightGeneration = undefined;
      signInContinuation = undefined;
      nativeAcquisitionGeneration = generation;
      acquisitionStarted = true;
      if (kind === "buy")
        track("purchase_started", { purchase_origin: "unknown", product: "still-pro-v3" });
      const result =
        kind === "buy"
          ? await deps.bridge.purchasePro(fresh!)
          : await deps.bridge.restorePro();
      try { purchaseObserved?.(result); }
      catch { /* Optional measurement cannot change a completed purchase outcome. */ }
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
        if (kind === "buy")
          track("purchase_cancelled", { purchase_origin: "unknown", product: "still-pro-v3" });
        purchase = { state: "idle" };
        restore = undefined;
        return;
      }
      if (result.outcome === "unavailable" && kind === "buy" && pendingKind === undefined) {
        track("purchase_failed", { purchase_origin: "unknown", product: "still-pro-v3", reason: "not_allowed" });
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
          // This also accepts isolated App Review rights. Do not report a live sale from this
          // generic ownership answer; canonical production purchase attribution is separate.
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
          if (kind === "buy")
            track("purchase_pending", { purchase_origin: "unknown", product: "still-pro-v3" });
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
      if (kind === "buy" && acquisitionStarted)
        track("purchase_failed", { purchase_origin: "unknown", product: "still-pro-v3", reason: "unknown" });
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
    if (stopped || busy || requestingLink || owner() === "none" || !eligiblePurchase) return;
    // Remembered before any read: a hold or an overlapping re-read cannot lose the request.
    linkingRequested = true;
    if (owner() !== "owned") return;
    requestingLink = true;
    try {
      const generation = ++linkGeneration;
      const before = deps.account();
      await refreshLinkEligibility(false);
      if (
        stopped ||
        busy ||
        generation !== linkGeneration ||
        before?.id !== deps.account()?.id ||
        before?.revision !== deps.account()?.revision
      )
        return;
      // A hold landed meanwhile or the read was overtaken: the request stays, and the next settled
      // owned, eligible answer offers it. A settled "not eligible" already cleared the request.
      if (owner() !== "owned" || !eligiblePurchase) return;
      const account = deps.account();
      if (linkedHere()) {
        // ISS-0081: already linked to this account (signed in as the holder from the invitation):
        // the request is done. Say so instead of asking to link it again.
        linkingRequested = false;
        linkSignInAsked = false;
        if (account?.confirmed) {
          linkAccount = { ...account };
          link = { state: "linked", email: account.email };
        }
        changed();
        return;
      }
      if (account?.confirmed && linkedElsewhere()) {
        // ISS-0104: the purchase is another account's; say so, offer nothing.
        linkingRequested = false;
        linkSignInAsked = false;
        linkAccount = { ...account };
        link = elsewhereCard(account);
        changed();
        return;
      }
      if (!account?.confirmed) {
        // Asked once per request: every later re-read must not reopen the sheet.
        if (!linkSignInAsked) {
          linkSignInAsked = true;
          linkViaSignIn = true;
          deps.signIn();
        }
        return;
      }
      linkSignInAsked = false;
      linkAccount = { ...account };
      const target = linkAccount;
      link = {
        state: "confirm",
        email: target.email,
        // Two reads, as the automatic link after a purchase: an access refresh landing during the
      // first re-read (the cache's minute refresh, a sync publish) must not fail a deliberate
      // link; a second overlap, or anything the reads cannot prove, ends in the failed card.
      onConfirm: () => void confirmLink(target, generation, requestLink, 2),
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
    } finally {
      requestingLink = false;
    }
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
      !sameAccount(account)
    )
      return;
    if (owner() !== "owned") {
      // Access is being re-checked right now: say so (Try again re-offers), never nothing.
      link = { state: "failed", email: account.email, onRetry };
      changed();
      return;
    }
    const operation = ++epoch;
    busy = true;
    link = { state: "pending", email: account.email };
    changed();
    try {
      let eligible: { readonly ownershipRevision: number } | null | undefined;
      // Native refuses a read while it is busy (a reconcile or revocation in flight); one such
      // refusal is asked again rather than failing the link. A verdict (an unproven purchaser or
      // access that changed meanwhile) keeps the attempt rule below.
      let refusals = 0;
      for (let attempt = 1; ; attempt++) {
        const observed = accessEpoch;
        try {
          eligible = await deps.readLinkEligibility?.();
        } catch (error) {
          if (refusals++ >= 1) throw error;
          attempt--;
          continue;
        }
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
      if (result.status === "owned_elsewhere") {
        // ISS-0104: held by another account at this revision; remembered for this account so the
        // offer does not come back, and shown as a fact rather than a failure with Try again.
        rememberHeldElsewhere(account.id, eligible!.ownershipRevision);
        link = elsewhereCard(account);
      } else {
        if (result.status === "linked" || result.status === "already_linked")
          forgetHeldElsewhere(account.id);
        link =
          result.status === "linked" || result.status === "already_linked"
            ? { state: "linked", email: account.email }
            : { state: "failed", email: account.email, onRetry };
      }
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
      if (!stopped) closeOffer();
    },
    accountChanged() {
      // Dismissal must not be attributed to a replacement account that never saw this opening.
      measuredOffer = false;
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
        const current = deps.account();
        const sameHolder =
          current !== null && current.id === linkAccount.id && current.email === linkAccount.email;
        if (sameHolder && (link?.state === "elsewhere" || link?.state === "linked")) {
          // ISS-0104, ISS-0081: where the purchase is linked is a fact about the account, not about
          // one session revision; the same account (id and address) keeps the card, and re-settles
          // it once the new revision is confirmed.
          if (current.confirmed) {
            linkAccount = { ...current };
            link = link.state === "linked" ? { state: "linked", email: current.email } : elsewhereCard(current);
          }
        } else if (
          sameHolder &&
          (link?.state === "confirm" || link?.state === "pending") &&
          linkingRequested &&
          linkViaSignIn
        ) {
          // ISS-0076 (MAC-85): the sign-in the request opened is still settling. The verified code
          // enters the session (a new revision, then a confirmation at it) before the controller
          // advances the revision again, so the confirmation can appear, and even be tapped, one
          // revision early. Fence its taps and any link in flight, keep the card without buttons
          // and the request, and offer a fresh confirmation once the new revision is confirmed.
          // linkAccount stays the fenced account, so a sign-out or another account still drops it.
          linkGeneration++;
          link = { state: "confirm", email: linkAccount.email };
        } else {
          clearLink();
        }
      }
      if (linkingRequested && (!linkAccount || fencedConfirm()) && deps.account()?.confirmed)
        void requestLink();
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
          if (!stopped) closeOffer();
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
            if (stopped) return;
            if (!opening && owner() === "none" && offer && deps.bridge.available) {
              measuredOffer = true;
              track("paywall_viewed", { trigger: "upgrade_button", where: "app" });
            }
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
    /** The sign-in sheet was closed without signing in: nothing is bought, and a link request
     * that opened it is dropped (a later sign-in offers the link card, not the confirmation). */
    signInDismissed() {
      let dropped = false;
      if (purchaseSignIn) {
        purchaseSignIn = false;
        purchaseSignInAccount = null;
        dropped = true;
      }
      if (linkSignInAsked && !deps.account()?.confirmed) {
        linkingRequested = false;
        linkSignInAsked = false;
        linkViaSignIn = false;
        dropped = true;
      }
      if (dropped) changed();
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
    /** ISS-0105: the signed-in account itself holds Still Pro, so the sync heading's tag reads
     * "Still Pro User". Only on positive provenance for the current access observation: this
     * observation's settled read says native's server-signed proof links this device's purchase to
     * this account (ISS-0081), or the account's own verified proof is in native's record (an Apple
     * purchase linked to it, or one bought on the web). Never inferred from missing device
     * evidence. Signed out, an accountless purchase, one linked to another account (ISS-0104), or
     * a read still pending or refused reads "Still Pro on this device". */
    get accountHoldsPro() {
      const current = deps.account();
      if (!current?.confirmed || !access || !proPurchased(access)) return false;
      if (eligibilityFresh && linkedHere()) return true;
      return accountProvenance?.account === current.id && accountProvenance.access === accessEpoch;
    },
    get canLink() {
      return (
        !busy &&
        owner() === "owned" &&
        eligiblePurchase !== null &&
        !linkedHere() &&
        !linkedElsewhere() &&
        !link
      );
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
