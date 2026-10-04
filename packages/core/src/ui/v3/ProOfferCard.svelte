<script lang="ts">
  import type { ProOfferCardProps } from "./extension-settings-presentation.js";
  import Glyph from "./Glyph.svelte";
  let {
    ownership,
    channel,
    offer,
    confirmedAccount,
    accessHeld = false,
    accessChecking = false,
    accessVerify = false,
    restoreHeld = false,
    state = "idle",
    onSignIn,
    onBuy,
    onRestore,
    onRetry,
  }: ProOfferCardProps = $props();
  let canBuy = $derived(
    ownership === "none" &&
      !accessHeld &&
      !accessChecking &&
      !accessVerify &&
      !restoreHeld &&
      channel === "ready" &&
      Boolean(offer?.price.trim()) &&
      state !== "failed",
  );
  function request() {
    if (!canBuy || state === "pending") return;
    if (confirmedAccount) onBuy?.();
    else onSignIn?.();
  }
</script>

<section class="card card-stack" aria-label="Still Pro">
  {#if ownership === "owned"}
    <div class="offer-head">
      <h2 class="card-title">Still Pro</h2>
      <span class="access-tag boxed">Purchased</span>
    </div>
    <p class="card-body">
      You have Still Pro. New controls start off, so turn on the ones you want.
    </p>
  {:else if (ownership === "checking" || accessChecking) && ownership !== "verify" && ownership !== "failed" && state !== "failed"}
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
    {#if canBuy && offer?.priceNote}<p
        class="card-body"
        style="margin-block-start:-8px;"
      >
        {offer.priceNote}
      </p>{/if}
    {#if canBuy}
      <button
        type="button"
        class="primary block"
        aria-busy={state === "pending" || undefined}
        disabled={state === "pending" ||
          (confirmedAccount ? !onBuy : !onSignIn)}
        onclick={request}
      >
        {state === "pending" ? "Waiting for checkout…" : "Get Still Pro"}
      </button>
    {:else if ownership === "verify" || (accessVerify && ownership !== "failed")}
      <div class="status-line" data-tone="caution" role="status">
        <span class="glyph"><Glyph name="clock" size={16} /></span>
        <div class="status-body">
          <span>Still Pro needs to be verified again.</span><span
            class="muted"
            style="font-size:calc(12.5px * var(--text-scale, 1));"
            >Go online and sign in. Free controls and your saved choices stay.</span
          >
        </div>
      </div>
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
    {:else if state !== "failed" && !restoreHeld}
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
              onclick={onRetry}>Try again</button
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
    <button
      type="button"
      class="link"
      disabled={!onRestore || restoreHeld}
      onclick={onRestore}>Restore purchase</button
    >
  {/if}
</section>
