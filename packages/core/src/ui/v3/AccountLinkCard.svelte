<script lang="ts">
  import type { AccountLinkCardProps } from "./extension-settings-presentation.js";
  import Glyph from "./Glyph.svelte";
  let {
    state,
    email,
    onConfirm,
    onChooseOther,
    onRetry,
    signOutNote = true,
  }: AccountLinkCardProps = $props();
</script>

<section class="card card-stack" aria-label="Link Still Pro">
  {#if state === "confirm"}
    <h2 class="card-title">Link Still Pro to this account?</h2>
    <p class="synced">{email}</p>
    <p class="card-body">
      You'll use this account to restore Still Pro in other browsers.
    </p>
    <button
      type="button"
      class="primary block"
      disabled={!onConfirm}
      onclick={onConfirm}>Link to this account</button
    >
    <button
      type="button"
      class="link center"
      disabled={!onChooseOther}
      onclick={onChooseOther}>Use a different account</button
    >
  {:else}
    <div
      class="status-line"
      data-tone={state === "failed"
        ? "failed"
        : state === "pending"
          ? "pending"
          : "success"}
      role={state === "failed" ? "alert" : "status"}
    >
      <span class="glyph"
        ><Glyph
          name={state === "failed"
            ? "alert"
            : state === "pending"
              ? "spinner"
              : "check"}
          size={16}
        /></span
      >
      <div class="status-body">
        <span
          >{state === "pending"
            ? `Linking Still Pro to ${email}…`
            : state === "linked"
              ? `Still Pro is linked to ${email}.`
              : "Linking didn't finish."}</span
        >
        {#if state === "failed"}<span
            class="muted"
            style="font-size:calc(12.5px * var(--text-scale, 1));"
            >Still Pro still works on this device.</span
          >{#if onRetry}<button
              type="button"
              class="link status-action"
              onclick={onRetry}>Try again</button
            >{/if}{/if}
      </div>
    </div>
  {/if}
  {#if signOutNote && state === "linked"}<p class="caption">
      Signing out removes account access here. A purchase made on this device
      keeps working.
    </p>{/if}
</section>
