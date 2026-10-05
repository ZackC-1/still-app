<script lang="ts">
  import type { NativeProOfferCardProps } from "./apple-settings-presentation.js";
  import Glyph from "./Glyph.svelte";
  let {
    ownership,
    channel,
    offer,
    accessHeld = false,
    restoreHeld = false,
    state = "idle",
    onBuy,
    onRestore,
    onRetry,
  }: NativeProOfferCardProps = $props();
  let ready = $derived(
    ownership === "none" &&
      !accessHeld &&
      !restoreHeld &&
      channel === "ready" &&
      Boolean(offer?.price) &&
      Boolean(onBuy) &&
      (state === "idle" || state === "pending"),
  );
  let retryReady = $derived(
    ownership === "none" &&
      !accessHeld &&
      !restoreHeld &&
      channel === "ready" &&
      Boolean(offer?.price) &&
      Boolean(onRetry) &&
      state === "failed",
  );
  let restoreReady = $derived(
    Boolean(onRestore) && !restoreHeld && state !== "pending",
  );
</script>

<section class="card card-stack" aria-label="Still Pro">
  {#if ownership === "verify"}
    <h2 class="card-title">Still Pro</h2>
    <div class="status-line" data-tone="caution" role="status">
      <span class="glyph"><Glyph name="clock" size={16} /></span>
      <div class="status-body">
        <span>Still Pro needs to be verified again.</span><span
          class="muted"
          style="font-size:calc(12.5px * var(--text-scale, 1));"
          >Your free controls and saved choices are unaffected.</span
        >
      </div>
    </div>
  {:else if ownership === "checking" || accessHeld}
    <h2 class="card-title">Still Pro</h2>
    <div class="status-line" data-tone="pending" role="status">
      <span class="glyph"><Glyph name="spinner" size={16} /></span>
      <div class="status-body">
        <span>Checking your Still Pro access…</span><span
          class="muted"
          style="font-size:calc(12.5px * var(--text-scale, 1));"
          >Your free controls keep working while this finishes.</span
        >
      </div>
    </div>
  {:else}
    <div class="offer-head"><h2 class="card-title">Still Pro</h2></div>
    {#if ready && offer?.priceNote}<p
        class="card-body"
        style="margin-block-start:-8px;"
      >
        {offer.priceNote}
      </p>{/if}
    {#if ready}
      <button
        type="button"
        class="primary block"
        aria-busy={state === "pending" || undefined}
        aria-disabled={state === "pending" || undefined}
        onclick={() => {
          if (ready && state === "idle") onBuy?.();
        }}
        >{state === "pending" ? "Waiting for Apple…" : "Get Still Pro"}</button
      >
    {:else if ownership === "failed"}
      <div class="status-line" data-tone="failed" role="alert">
        <span class="glyph"><Glyph name="alert" size={16} /></span>
        <div class="status-body">
          <span>We couldn't finish checking. Nothing changed.</span><span
            class="muted"
            style="font-size:calc(12.5px * var(--text-scale, 1));"
            >Your free controls and saved choices are unaffected.</span
          >
        </div>
      </div>
    {:else if state === "idle" && !restoreHeld}
      <div class="status-line" data-tone="info">
        <div class="status-body">
          <span>Still Pro can't be bought here yet.</span><span
            class="muted"
            style="font-size:calc(12.5px * var(--text-scale, 1));"
            >Already bought it somewhere else? Restore it below.</span
          >
        </div>
      </div>
    {/if}
    {#if state === "failed"}
      <div class="status-line" data-tone="failed" role="alert">
        <span class="glyph"><Glyph name="alert" size={16} /></span>
        <div class="status-body">
          <span>The purchase wasn't confirmed.</span><span
            class="muted"
            style="font-size:calc(12.5px * var(--text-scale, 1));"
            >If you were charged, Restore purchase will find it.</span
          >{#if onRetry}<button
              type="button"
              class="link status-action"
              disabled={!retryReady}
              onclick={() => {
                if (retryReady) onRetry?.();
              }}>Try again</button
            >{/if}
        </div>
      </div>
    {:else if state === "success"}
      <div class="status-line" data-tone="success" role="status">
        <span class="glyph"><Glyph name="check" size={16} /></span>
        <div class="status-body">
          <span>Still Pro is ready. New controls start off.</span>
        </div>
      </div>
    {/if}
    {#if ready && offer?.refundNote}<p class="caption">
        {offer.refundNote}
      </p>{/if}
  {/if}
  <button
    type="button"
    class="link"
    disabled={!restoreReady}
    onclick={() => {
      if (restoreReady) onRestore?.();
    }}>Restore purchase</button
  >
</section>
