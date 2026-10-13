<script lang="ts">
  // The popup's compact Still Pro card (ISS-0032, owner-approved design, 12 Oct 2026): one line of
  // value and Get Still Pro, under the site list and above Settings sync. The popup renders it only
  // while access is conclusively locked and the host supplied a real destination. It never starts a
  // payment: Get Still Pro opens the full offer (the browser Settings page's Still Pro card, or the
  // Still app on Safari). No number of extras and no price (owner rules).
  import Glyph from "./Glyph.svelte";
  import { POPUP_PRO_VALUE } from "./presentation.js";

  let {
    onOpen,
    appHandoff = false,
  }: {
    onOpen: () => void;
    /** Safari: Get Still Pro opens the Still app, and the card says so. */
    appHandoff?: boolean;
  } = $props();
</script>

<section class="card card-stack pro-entry" aria-labelledby="popup-pro-h">
  <div class="sync-row">
    <div class="sync-row-text">
      <h2 class="sync-row-title" id="popup-pro-h">Still Pro</h2>
      <p class="muted sync-row-sub">{POPUP_PRO_VALUE}</p>
    </div>
    <button
      type="button"
      class="primary inline"
      class:with-glyph={appHandoff}
      aria-describedby={appHandoff ? "popup-pro-handoff" : undefined}
      onclick={onOpen}
      >Get Still Pro{#if appHandoff}<Glyph name="external" size={13} />{/if}</button
    >
  </div>
  {#if appHandoff}<p class="handoff" id="popup-pro-handoff">
      <Glyph name="external" size={13} />Opens the Still app
    </p>{/if}
</section>
