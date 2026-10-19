<script lang="ts">
  import type { ProOfferCardProps } from "./extension-settings-presentation.js";
  import Glyph from "./Glyph.svelte";
  import StaticProControlList from "./StaticProControlList.svelte";
  import { PAID_TIER_ENABLED } from "@still/shared-types";
  import { proValueBySite } from "./presentation.js";
  import { serviceIconSrc } from "./service-icons.js";
  let {
    ownership,
    controls = [],
    features,
    platformKnown = true,
    channel,
    offer,
    confirmedAccount,
    knownMissing,
    accessHeld = false,
    accessChecking = false,
    accessVerify = false,
    restoreHeld = false,
    state = "idle",
    onSignIn,
    onBuy,
    onRestore,
    onRetry,
  }: ProOfferCardProps & { knownMissing: boolean } = $props();
  let canBuy = $derived(
    knownMissing &&
      ownership === "none" &&
      !accessHeld &&
      !accessChecking &&
      !accessVerify &&
      !restoreHeld &&
      channel === "ready" &&
      // A checkout-priced offer carries no price here (the checkout page shows it); only a build
      // compiled with the paid tier on may accept it. Every other offer still needs its verified
      // price. With the paid tier off this folds to the price check alone.
      ((PAID_TIER_ENABLED && offer?.checkoutPriced === true) ||
        Boolean(offer?.price.trim())) &&
      state !== "failed" &&
      state !== "success",
  );
  // The value-led offer (ISS-0032, owner-approved design): shown only while access is conclusively
  // locked, as what the extras hide on each site, then the one-time terms. No counts, no price.
  // The one-time terms sit only beside a live Get Still Pro, so the card never states purchase terms
  // it is not offering (a closed channel, a Restore check in progress, a finished purchase).
  let valueLed = $derived(
    ownership === "none" &&
      knownMissing &&
      !accessHeld &&
      !accessChecking &&
      !accessVerify &&
      !restoreHeld &&
      state !== "success" &&
      platformKnown &&
      controls.length === 0,
  );
  let value = $derived(valueLed ? proValueBySite(features) : []);
  let checkoutPriced = $derived(
    PAID_TIER_ENABLED && offer?.checkoutPriced === true,
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
      <span class="access-tag boxed success">Still Pro Purchased</span>
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
    {#if canBuy && offer?.priceNote && !checkoutPriced}<p
        class="card-body"
        style="margin-block-start:-8px;"
      >
        {offer.priceNote}
      </p>{/if}
    {#if controls.length}<StaticProControlList {controls} />{/if}
    {#if valueLed}
      <p class="card-body">Extras that hide more of what distracts you.</p>
      <ul class="value-list">
        {#each value as row (row.service)}
          <li>
            <img src={serviceIconSrc[row.service]} alt="" />
            <div>
              <div class="site">{row.site}</div>
              <div class="what">{row.what}</div>
            </div>
          </li>
        {/each}
      </ul>
      {#if canBuy}<p class="offer-terms">One-time purchase. Lifetime access.</p>{/if}
    {/if}
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
      {#if checkoutPriced}<p class="caption">The price is shown at checkout.</p>{/if}
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
    {:else if state !== "failed" && state !== "success" && !restoreHeld}
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
