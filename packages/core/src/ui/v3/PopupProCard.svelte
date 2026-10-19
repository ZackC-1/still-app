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
    checking = false,
  }: {
    onOpen?: () => void;
    /** Still is still finding out: a muted line in the card's place, no button. */
    checking?: boolean;
    /** Safari: Get Still Pro opens the Still app, and the card says so. */
    appHandoff?: boolean;
  } = $props();
</script>

{#if checking}
  <section class="card card-stack" aria-labelledby="popup-pro-checking">
    <div class="status-line" data-tone="pending" role="status">
      <span class="glyph"><Glyph name="spinner" size={16} /></span>
      <div class="status-body">
        <span id="popup-pro-checking">Checking your Still Pro access…</span>
      </div>
    </div>
  </section>
{:else}
<section class="card card-stack pro-entry" aria-labelledby="popup-pro-h">
  <div class="sync-row">
    <div class="sync-row-text">
      <h2 class="sync-row-title" id="popup-pro-h">Still Pro</h2>
      <p class="muted sync-row-sub">{POPUP_PRO_VALUE}</p>
    </div>
    <div class:popup-action={appHandoff}>
    <button
      type="button"
      class="primary inline"
      aria-describedby={appHandoff ? "popup-pro-handoff" : undefined}
      onclick={onOpen}
      >Get Still Pro</button
    >
  {#if appHandoff}<p class="handoff" id="popup-pro-handoff">
      Opens the Still app
    </p>{/if}
    </div>
  </div>
</section>
{/if}
