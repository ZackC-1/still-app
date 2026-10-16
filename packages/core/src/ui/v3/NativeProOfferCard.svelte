<script lang="ts">
  import type { NativeProOfferCardProps } from "./apple-settings-presentation.js";
  import Glyph from "./Glyph.svelte";
  let {
    ownership,
    channel,
    offer,
    accessHeld = false,
    accessChecking = false,
    accessVerify = false,
    restoreHeld = false,
    state = "idle",
    verificationRequired = false,
    notCharged = false,
    onBuy,
    onRestore,
    onRetry,
  }: NativeProOfferCardProps = $props();
  let held = $derived(accessHeld || accessChecking || accessVerify);
  let ready = $derived(
    ownership === "none" &&
      !held &&
      !restoreHeld &&
      channel === "ready" &&
      Boolean(offer?.price.trim()) &&
      Boolean(onBuy) &&
      (state === "idle" || state === "pending"),
  );
  let retryReady = $derived(
    ownership === "none" &&
      !held &&
      !restoreHeld &&
      channel === "ready" &&
      Boolean(offer?.price.trim()) &&
      Boolean(onRetry) &&
      state === "failed",
  );
  let restoreReady = $derived(
    Boolean(onRestore) && !restoreHeld && state !== "pending",
  );
</script>

<section class="card card-stack" aria-label="Still Pro">
  <!-- The app card is heading, "One-time purchase. Lifetime access.", Get Still Pro and Restore
    purchase (owner, 12 Oct 2026, ISS-0029 item 11): no device line or refund note. No Still Pro
    surface states a number of extras (owner rule, 12 Oct 2026). -->
  <!-- Mirrors ProOfferCard: verify and failed ownership or a failed purchase show their own
    state, never the spinner. A residual held access counts as checking unless verify is held. -->
  {#if ownership === "owned"}
    <div class="offer-head">
      <h2 class="card-title">Still Pro</h2>
      <span class="access-tag boxed">Purchased</span>
    </div>
    <p class="card-body">
      You have Still Pro. New controls start off, so turn on the ones you want.
    </p>
  {:else if verificationRequired}
    <h2 class="card-title">Still Pro</h2>
    <div class="status-line" data-tone="caution" role="status">
      <span class="glyph"><Glyph name="clock" size={16} /></span>
      <div class="status-body">
        <span>Your purchase needs to be verified.</span>
      </div>
    </div>
  {:else if (ownership === "checking" || accessChecking || (accessHeld && !accessVerify)) && ownership !== "verify" && ownership !== "failed" && state !== "failed"}
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
    {:else if ownership === "verify" || (accessVerify && ownership !== "failed")}
      <div class="status-line" data-tone="caution" role="status">
        <span class="glyph"><Glyph name="clock" size={16} /></span>
        <div class="status-body">
          <span>Still Pro needs to be verified again.</span>
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
          <!-- Only a Buy the App Store never started may say nothing was charged (ISS-0070);
            any other failure may follow a charge, so it points to Restore purchase. -->
          {#if notCharged}<span>Still Pro couldn't be bought right now.</span><span
              class="muted"
              style="font-size:calc(12.5px * var(--text-scale, 1));"
              >Nothing was charged. Make sure you're signed in to the App Store, then try again.</span
            >{:else}<span>The purchase wasn't confirmed.</span><span
              class="muted"
              style="font-size:calc(12.5px * var(--text-scale, 1));"
              >If you were charged, Restore purchase will find it.</span
            >{/if}{#if onRetry}<button
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
  {/if}
  {#if ownership !== "owned"}<button
      type="button"
      class="link"
      disabled={!restoreReady}
      onclick={() => {
        if (restoreReady) onRestore?.();
      }}>Restore purchase</button
    >{/if}
</section>
