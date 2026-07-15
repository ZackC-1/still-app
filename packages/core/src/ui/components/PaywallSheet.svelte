<script lang="ts">
  import { STRINGS } from "../strings.js";
  import { FIND_MY_PURCHASE_MAILTO } from "../config.js";
  import { trapFocus } from "../focus-trap.js";
  import type {
    CheckoutFlow,
    PurchaseFlow,
    SuccessScreen,
  } from "../controller.svelte.js";

  interface Props {
    canPurchase: boolean;
    onGet?: () => void;
    onRestore?: () => void;
    onDismiss: () => void;
    /** The post-purchase success screen (R3): replaces the sheet's content with the dedicated
     * two-choice presentation (account pitch signed out, sync confirmation signed in). NO
     * auto-dismiss — dismissal is an explicit choice, unlike the 2.5s payoff below. */
    successScreen?: SuccessScreen;
    /** The success screen's account CTA (routes to the sign-in sheet). */
    onCreateAccount?: () => void;
    /** Signed-out rendering (purchase-first): relabels Restore to the returner's question and
     * shows the no-account-needed reassurance under the CTA. */
    signedOut?: boolean;
    /** Purchase/restore flow state — drives the in-flight/outcome UI (P1 #5). */
    purchaseFlow?: PurchaseFlow;
    purchaseError?: string | null;
    /** Checkout-pending lifecycle (plan U4/R3): checking / quiet-pending / stale find-my-purchase
     * / auth-required re-sign-in. Any state but "none" replaces the sheet's purchase content. */
    checkoutFlow?: CheckoutFlow;
    /** "I didn't finish checkout — start over": clears the pending flag immediately (U4). */
    onStartOver?: () => void;
    /** Re-sign-in from the auth-required state — preserves the pending flag + cached rows (U4). */
    onReSignIn?: () => void;
    /** Localized store price (e.g. "$1.99"), fetched from StoreKit via RevenueCat. Null
     * until loaded or unavailable — the CTA then shows without a price suffix rather than a guess. */
    price?: string | null;
    /** The success payoff (U3/R6): replaces the sheet's content with the quieter-web confirmation
     * while the newly unlocked rows switch on behind it. The controller owns its
     * lifetime (~2.5s auto-dismiss; tap/Escape dismiss early through onDismiss). */
    justUnlocked?: boolean;
  }
  let {
    canPurchase,
    onGet,
    onRestore,
    onDismiss,
    successScreen = "none",
    onCreateAccount,
    signedOut = false,
    purchaseFlow = "idle",
    purchaseError = null,
    checkoutFlow = "none",
    onStartOver,
    onReSignIn,
    price = null,
    justUnlocked = false,
  }: Props = $props();
  let sheet = $state<HTMLDivElement>();

  $effect(() =>
    trapFocus({
      container: () => sheet,
      // The stale-pending state's find-my-purchase mailto is an anchor — keep it in the trap.
      focusable: "button, a[href]",
      onDismiss: () => onDismiss(),
    }),
  );

  const busy = $derived(
    purchaseFlow === "purchasing" ||
      purchaseFlow === "opening-checkout" ||
      purchaseFlow === "restoring",
  );

  // The outcome line shown beneath the buttons (kept open through every non-purchased state).
  const status = $derived.by(() => {
    switch (purchaseFlow) {
      case "pending":
        return STRINGS.paywall.pending;
      case "cancelled":
        return STRINGS.paywall.cancelled;
      case "failed":
        return purchaseError ?? STRINGS.paywall.failed;
      case "unavailable":
        return STRINGS.paywall.unavailable;
      case "stale-identity":
        return STRINGS.paywall.staleIdentity;
      case "restored-none":
        return STRINGS.paywall.restoredNone;
      default:
        return null;
    }
  });

  $effect(() => {
    // Re-runs when the content swaps to the payoff, the success screen, or a checkout-pending
    // state (the previously focused control unmounts): focus must stay inside the sheet so Escape
    // keeps dismissing. On the success screen the first focusable is the account CTA by markup
    // order — the intended initial focus.
    void justUnlocked;
    void checkoutFlow;
    void successScreen;
    sheet?.querySelector<HTMLElement>("button, a[href]")?.focus();
  });
</script>

<button
  type="button"
  class="scrim"
  aria-label={STRINGS.paywall.dismiss}
  tabindex="-1"
  onclick={onDismiss}
></button>
<div
  class="sheet"
  bind:this={sheet}
  role="dialog"
  aria-modal="true"
  aria-label={STRINGS.paywall.title}
  tabindex="-1"
>
  {#if successScreen !== "none"}
    <!-- The post-purchase success screen (R3, purchase-first): a dedicated presentation, NOT the
         auto-dismissing payoff — it persists until an explicit choice. Signed out: the optional-
         account pitch with two equal-weight, independently focusable actions (the classic 5.1.1
         re-rejection is a skip that reads as subordinate). Signed in: sync confirmation only. -->
    <h2 role="status">{STRINGS.success.title}</h2>
    {#if successScreen === "account-pitch"}
      <p class="scope">{STRINGS.success.accountPitch}</p>
      <button class="primary" onclick={onCreateAccount}
        >{STRINGS.success.createAccount}</button
      >
      <button class="secondary" onclick={onDismiss}
        >{STRINGS.success.notNow}</button
      >
      <p class="reassure">{STRINGS.success.reassure}</p>
    {:else}
      <p>{STRINGS.success.synced}</p>
      <button class="primary" onclick={onDismiss}>{STRINGS.success.done}</button
      >
    {/if}
  {:else if justUnlocked}
    <!-- The payoff (U3/R6): one line while the unlocked rows switch on behind the sheet. A button
         so a tap anywhere on it dismisses early (the controller also auto-dismisses in ~2.5s).
         Purchases never land here — they resolve through the success screen above; this remains
         the quiet path for non-purchase entitlement transitions (web checkout, account sign-in). -->
    <button class="payoff" onclick={onDismiss}>
      <span role="status">{STRINGS.paywall.unlocked}</span>
    </button>
  {:else if checkoutFlow === "checking" || checkoutFlow === "quiet-pending"}
    <!-- Rehydrated checkout-pending (U4/R3): the fast-poll window ("checking") or its exhausted
         rest state ("quiet-pending" — reopening the popup starts a fresh window). Start-over is
         always one tap away: abandonment must never trap the buyer (U4). -->
    <h2>{STRINGS.paywall.title}</h2>
    <p role="status">
      {checkoutFlow === "checking"
        ? STRINGS.paywall.checking
        : STRINGS.paywall.quietPending}
    </p>
    <button class="secondary" onclick={onStartOver}
      >{STRINGS.paywall.startOver}</button
    >
    <button class="dismiss" onclick={onDismiss}
      >{STRINGS.paywall.dismiss}</button
    >
  {:else if checkoutFlow === "stale-pending"}
    <!-- Pending decayed past 24h (U4): the already-decided support path — find-my-purchase mailto
         (docs/monetization-design.md) plus a retry that replaces the flag (409 guards doubles). -->
    <h2>{STRINGS.paywall.title}</h2>
    <p>{STRINGS.paywall.stalePending}</p>
    <a class="primary linkbutton" href={FIND_MY_PURCHASE_MAILTO}
      >{STRINGS.paywall.findMyPurchase}</a
    >
    <button class="secondary" onclick={onGet}
      >{STRINGS.paywall.retryCheckout}</button
    >
    <button class="dismiss" onclick={onStartOver}
      >{STRINGS.paywall.startOver}</button
    >
    <button class="dismiss" onclick={onDismiss}
      >{STRINGS.paywall.dismiss}</button
    >
  {:else if checkoutFlow === "auth-required"}
    <!-- Session died mid-checkout (U4): re-sign-in is the remedy — the pending flag and the cached
         entitlement both survive (never teardown, never a downgrade). -->
    <h2>{STRINGS.paywall.title}</h2>
    <p>{STRINGS.paywall.authRequired}</p>
    <button class="primary" onclick={onReSignIn}
      >{STRINGS.paywall.signInAgain}</button
    >
    <button class="dismiss" onclick={onDismiss}
      >{STRINGS.paywall.dismiss}</button
    >
  {:else}
    <h2>{STRINGS.paywall.headline}</h2>
    {#if canPurchase}
      <p>{STRINGS.paywall.body}</p>
      <p class="scope">{STRINGS.paywall.scope}</p>
      <button class="primary" onclick={onGet} disabled={busy}>
        {#if purchaseFlow === "purchasing"}
          {STRINGS.paywall.purchasing}
        {:else if purchaseFlow === "opening-checkout"}
          {STRINGS.paywall.openingCheckout}
        {:else if purchaseFlow === "stale-identity"}
          {STRINGS.paywall.retryPurchase}
        {:else if price}
          {STRINGS.paywall.cta} · {price}
        {:else}
          {STRINGS.paywall.cta}
        {/if}
      </button>
      <button class="secondary" onclick={onRestore} disabled={busy}>
        {purchaseFlow === "restoring"
          ? STRINGS.paywall.restoring
          : signedOut
            ? STRINGS.paywall.restoreSignedOut
            : STRINGS.paywall.restore}
      </button>
      <p class="reassure">{STRINGS.paywall.reassurance}</p>
      {#if signedOut}
        <p class="reassure">{STRINGS.paywall.noAccountNeeded}</p>
      {/if}
      {#if status}
        <p class="status" class:error={purchaseFlow === "failed"} role="status">
          {status}
        </p>
      {/if}
    {:else}
      <p>{STRINGS.paywall.nonApple}</p>
    {/if}
    <button class="dismiss" onclick={onDismiss}
      >{STRINGS.paywall.dismiss}</button
    >
  {/if}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    border: 0;
    padding: 0;
    z-index: 100;
  }
  .sheet {
    position: fixed;
    inset-block-end: 0;
    inset-inline: 0;
    margin-inline: auto;
    inline-size: min(100%, 420px);
    /* vh fallback for older WebKit (iOS 15.0–15.3) that drops the dvh declaration below. */
    max-block-size: calc(100vh - env(safe-area-inset-top) - var(--space-3));
    max-block-size: calc(100dvh - env(safe-area-inset-top) - var(--space-3));
    background: var(--surface);
    border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
    border: 1px solid var(--border);
    padding: var(--space-6);
    padding-block-end: calc(var(--space-6) + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    overflow-y: auto;
    overscroll-behavior: contain;
    z-index: 101;
  }
  h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
  }
  p {
    margin: 0;
    color: var(--ink-secondary);
  }
  button {
    border-radius: var(--radius-control);
    padding: var(--space-3) var(--space-4);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
  }
  .primary {
    background: var(--still-blue);
    color: var(--on-blue);
    border: none;
  }
  .secondary {
    background: transparent;
    color: var(--ink);
    border: 1px solid var(--border);
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .reassure {
    font-size: 13.5px;
    text-align: center;
  }
  .scope {
    padding: var(--space-3);
    border-inline-start: 3px solid var(--still-blue);
    background: var(--surface-raised);
    color: var(--ink-secondary);
    font-size: 13px;
    line-height: 1.45;
  }
  .status {
    color: var(--ink-secondary);
    font-size: 14px;
  }
  .payoff {
    background: transparent;
    border: none;
    padding: var(--space-6) 0;
    font: inherit;
    font-size: 17px;
    font-weight: 600;
    color: var(--ink);
    text-align: center;
  }
  /* The find-my-purchase mailto (U4): an anchor rendered with the primary-button look. */
  .linkbutton {
    display: block;
    border-radius: var(--radius-control);
    padding: var(--space-3) var(--space-4);
    font-weight: 500;
    text-align: center;
    text-decoration: none;
  }
  .status.error {
    color: #c2261e;
  }
  .dismiss {
    background: transparent;
    color: var(--ink-secondary);
    border: none;
  }
</style>
