<script lang="ts">
  import { STRINGS } from "../strings.js";
  import { FIND_MY_PURCHASE_MAILTO } from "../config.js";
  import type { CheckoutFlow, PurchaseFlow } from "../controller.svelte.js";

  interface Props {
    canPurchase: boolean;
    onGet?: () => void;
    onRestore?: () => void;
    onDismiss: () => void;
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
    /** The success payoff (U3/R6): replaces the sheet's content with "Pro unlocked. Enjoy the
     * quiet." while the newly unlocked rows switch on behind it. The controller owns its
     * lifetime (~2.5s auto-dismiss; tap/Escape dismiss early through onDismiss). */
    justUnlocked?: boolean;
  }
  let {
    canPurchase,
    onGet,
    onRestore,
    onDismiss,
    purchaseFlow = "idle",
    purchaseError = null,
    checkoutFlow = "none",
    onStartOver,
    onReSignIn,
    price = null,
    justUnlocked = false,
  }: Props = $props();
  let sheet = $state<HTMLDivElement>();

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
      case "restored-none":
        return STRINGS.paywall.restoredNone;
      default:
        return null;
    }
  });

  $effect(() => {
    // Re-runs when the content swaps to the payoff or a checkout-pending state (the previously
    // focused control unmounts): focus must stay inside the sheet so Escape keeps dismissing.
    void justUnlocked;
    void checkoutFlow;
    sheet?.querySelector<HTMLElement>("button, a[href]")?.focus();
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      onDismiss();
      return;
    }
    if (e.key === "Tab" && sheet) {
      // The stale-pending state's find-my-purchase mailto is an anchor — keep it in the trap.
      const focusables = [...sheet.querySelectorAll<HTMLElement>("button, a[href]")];
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
</script>

<div class="scrim" role="presentation" onclick={onDismiss}></div>
<div
  class="sheet"
  bind:this={sheet}
  role="dialog"
  aria-modal="true"
  aria-label={STRINGS.paywall.title}
  tabindex="-1"
  onkeydown={onKeydown}
>
  {#if justUnlocked}
    <!-- The payoff (U3/R6): one line while the unlocked rows switch on behind the sheet. A button
         so a tap anywhere on it dismisses early (the controller also auto-dismisses in ~2.5s). -->
    <button class="payoff" onclick={onDismiss}>
      <span role="status">{STRINGS.paywall.unlocked}</span>
    </button>
  {:else if checkoutFlow === "checking" || checkoutFlow === "quiet-pending"}
    <!-- Rehydrated checkout-pending (U4/R3): the fast-poll window ("checking") or its exhausted
         rest state ("quiet-pending" — reopening the popup starts a fresh window). Start-over is
         always one tap away: abandonment must never trap the buyer (U4). -->
    <h2>{STRINGS.paywall.title}</h2>
    <p role="status">
      {checkoutFlow === "checking" ? STRINGS.paywall.checking : STRINGS.paywall.quietPending}
    </p>
    <button class="secondary" onclick={onStartOver}>{STRINGS.paywall.startOver}</button>
    <button class="dismiss" onclick={onDismiss}>{STRINGS.paywall.dismiss}</button>
  {:else if checkoutFlow === "stale-pending"}
    <!-- Pending decayed past 24h (U4): the already-decided support path — find-my-purchase mailto
         (docs/monetization-design.md) plus a retry that replaces the flag (409 guards doubles). -->
    <h2>{STRINGS.paywall.title}</h2>
    <p>{STRINGS.paywall.stalePending}</p>
    <a class="primary linkbutton" href={FIND_MY_PURCHASE_MAILTO}>{STRINGS.paywall.findMyPurchase}</a>
    <button class="secondary" onclick={onGet}>{STRINGS.paywall.retryCheckout}</button>
    <button class="dismiss" onclick={onStartOver}>{STRINGS.paywall.startOver}</button>
    <button class="dismiss" onclick={onDismiss}>{STRINGS.paywall.dismiss}</button>
  {:else if checkoutFlow === "auth-required"}
    <!-- Session died mid-checkout (U4): re-sign-in is the remedy — the pending flag and the cached
         entitlement both survive (never teardown, never a downgrade). -->
    <h2>{STRINGS.paywall.title}</h2>
    <p>{STRINGS.paywall.authRequired}</p>
    <button class="primary" onclick={onReSignIn}>{STRINGS.paywall.signInAgain}</button>
    <button class="dismiss" onclick={onDismiss}>{STRINGS.paywall.dismiss}</button>
  {:else}
    <h2>{STRINGS.paywall.headline}</h2>
    {#if canPurchase}
      <p>{STRINGS.paywall.body}</p>
      <button class="primary" onclick={onGet} disabled={busy}>
        {#if purchaseFlow === "purchasing"}
          {STRINGS.paywall.purchasing}
        {:else if purchaseFlow === "opening-checkout"}
          {STRINGS.paywall.openingCheckout}
        {:else if price}
          {STRINGS.paywall.cta} · {price}
        {:else}
          {STRINGS.paywall.cta}
        {/if}
      </button>
      <button class="secondary" onclick={onRestore} disabled={busy}>
        {purchaseFlow === "restoring" ? STRINGS.paywall.restoring : STRINGS.paywall.restore}
      </button>
      <p class="reassure">{STRINGS.paywall.reassurance}</p>
      {#if status}
        <p class="status" class:error={purchaseFlow === "failed"} role="status">{status}</p>
      {/if}
    {:else}
      <p>{STRINGS.paywall.nonApple}</p>
    {/if}
    <button class="dismiss" onclick={onDismiss}>{STRINGS.paywall.dismiss}</button>
  {/if}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
  }
  .sheet {
    position: fixed;
    inset-block-end: 0;
    inset-inline: 0;
    margin-inline: auto;
    max-inline-size: 420px;
    background: var(--surface);
    border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
    border: 1px solid var(--border);
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
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
