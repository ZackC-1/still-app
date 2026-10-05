<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { trapFocus } from "../focus-trap.js";
  import Glyph from "./Glyph.svelte";

  // Owner decision 41: once Still Pro is offered, a locked row opens this sheet with the host's
  // existing offer inside. It must be easy to leave after an accidental tap: the X, Escape and a
  // tap or click outside all close it, and focus goes back to the row that opened it. Opening it
  // starts nothing; only the offer's own explicit Buy does. Hosts render it only while the paid
  // world supplies a real offer, so it never appears while the paid tier is off.
  let {
    opener,
    onDismiss,
    children,
  }: {
    /** The lock button that opened the sheet; focus returns to it on close. */
    opener?: HTMLElement;
    onDismiss: () => void;
    children: Snippet;
  } = $props();
  let sheet: HTMLElement | undefined = $state();
  const focusable = "button:not(:disabled), a[href], input:not(:disabled)";

  $effect(() => {
    if (!sheet) return;
    const release = trapFocus({
      container: () => sheet,
      focusable,
      onDismiss: () => onDismiss(),
    });
    // The X takes focus first, so Enter or Space right after an accidental tap only closes.
    untrack(() => sheet?.querySelector<HTMLElement>(focusable)?.focus());
    const back = untrack(() => opener);
    return () => {
      release();
      if (back?.isConnected) back.focus();
    };
  });
</script>

<button
  type="button"
  class="scrim"
  tabindex="-1"
  aria-label="Close"
  aria-hidden="true"
  onclick={() => onDismiss()}
></button>
<div
  bind:this={sheet}
  class="sheet"
  role="dialog"
  tabindex="-1"
  aria-modal="true"
  aria-label="Still Pro"
>
  <div class="grip" aria-hidden="true"></div>
  <button
    type="button"
    class="dismiss sheet-close"
    aria-label="Close"
    onclick={() => onDismiss()}><Glyph name="close" size={18} /></button
  >
  {@render children()}
</div>
