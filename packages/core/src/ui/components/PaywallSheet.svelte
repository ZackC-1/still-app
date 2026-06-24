<script lang="ts">
  import { STRINGS } from "../strings.js";

  interface Props {
    canPurchase: boolean;
    onGet?: () => void;
    onRestore?: () => void;
    onDismiss: () => void;
  }
  let { canPurchase, onGet, onRestore, onDismiss }: Props = $props();
  let sheet = $state<HTMLDivElement>();

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
    <button class="primary" onclick={onGet}>{STRINGS.paywall.cta} · {STRINGS.paywall.price}</button>
    <button class="secondary" onclick={onRestore}>{STRINGS.paywall.restore}</button>
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
  .dismiss {
    background: transparent;
    color: var(--ink-secondary);
    border: none;
  }
</style>
