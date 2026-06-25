<script lang="ts">
  import { STRINGS } from "../strings.js";
  import type { PurchaseFlow } from "../controller.svelte.js";

  interface Props {
    canPurchase: boolean;
    onGet?: () => void;
    onRestore?: () => void;
    onDismiss: () => void;
    /** Purchase/restore flow state — drives the in-flight/outcome UI (P1 #5). */
    purchaseFlow?: PurchaseFlow;
    purchaseError?: string | null;
  }
  let {
    canPurchase,
    onGet,
    onRestore,
    onDismiss,
    purchaseFlow = "idle",
    purchaseError = null,
  }: Props = $props();
  let sheet = $state<HTMLDivElement>();

  const busy = $derived(purchaseFlow === "purchasing" || purchaseFlow === "restoring");

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
    sheet?.querySelector<HTMLElement>("button")?.focus();
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      onDismiss();
      return;
    }
    if (e.key === "Tab" && sheet) {
      const focusables = [...sheet.querySelectorAll<HTMLElement>("button")];
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
  <h2>{STRINGS.paywall.title}</h2>
  {#if canPurchase}
    <p>{STRINGS.paywall.body}</p>
    <button class="primary" onclick={onGet} disabled={busy}>
      {purchaseFlow === "purchasing"
        ? STRINGS.paywall.purchasing
        : `${STRINGS.paywall.cta} · ${STRINGS.paywall.price}`}
    </button>
    <button class="secondary" onclick={onRestore} disabled={busy}>
      {purchaseFlow === "restoring" ? STRINGS.paywall.restoring : STRINGS.paywall.restore}
    </button>
    {#if status}
      <p class="status" class:error={purchaseFlow === "failed"} role="status">{status}</p>
    {/if}
  {:else}
    <p>{STRINGS.paywall.nonApple}</p>
  {/if}
  <button class="dismiss" onclick={onDismiss}>{STRINGS.paywall.dismiss}</button>
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
  .status {
    color: var(--ink-secondary);
    font-size: 14px;
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
