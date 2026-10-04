<script lang="ts">
  import type { SharingCardProps } from "./extension-settings-presentation.js";
  import Toggle from "./Toggle.svelte";
  import Glyph from "./Glyph.svelte";
  let {
    state,
    purposes,
    purposesVerified = false,
    withdrawal = "none",
    onShare,
    onDecline,
    onChange,
    onRequestDeletion,
    onRetry,
  }: SharingCardProps = $props();
  let canShare = $derived(
    purposesVerified && Boolean(purposes?.length) && Boolean(onShare),
  );
  let withdrawalHeld = $derived(withdrawal === "failed");
  const outcomes = {
    requested: {
      tone: "pending",
      text: "Deletion requested. Your shared data hasn't been deleted yet.",
    },
    verifying: {
      tone: "pending",
      text: "Confirming deletion with our providers…",
    },
    deleted: { tone: "success", text: "Your shared data has been deleted." },
    failed: {
      tone: "failed",
      text: "We couldn't send your deletion request. Sharing stays off on this device.",
    },
  } as const;
  let outcome = $derived(
    withdrawal === "none" ? undefined : outcomes[withdrawal],
  );
</script>

<section
  class="card card-stack"
  aria-labelledby={state === "unasked" ? "consent-title" : undefined}
>
  {#if state === "unasked"}
    <h2 class="card-title" id="consent-title">
      Share your email and usage data with Still?
    </h2>
    {#if purposesVerified && purposes?.length}<ul class="purpose-list">
        {#each purposes as purpose (purpose.name)}<li>
            <span class="purpose-name">{purpose.name}</span><span
              >{purpose.text}</span
            >
          </li>{/each}
      </ul>{/if}
    <p class="card-body">
      Still never tracks or monitors the website you visit
    </p>
    <div class="choice-actions">
      <button
        type="button"
        class="secondary"
        disabled={!onDecline}
        onclick={onDecline}>Don't share</button
      >
      <button
        type="button"
        class="secondary"
        aria-disabled={!canShare || undefined}
        onclick={() => {
          if (canShare) onShare?.();
        }}>Share</button
      >
    </div>
    <p class="caption">
      Optional. Signing in or buying Still Pro never turns this on. Still works
      the same either way, and you can change it in Settings on this device.
    </p>
  {:else}
    <div class="sync-row">
      <div class="sync-row-text">
        <span
          class="row-title"
          id="share-t"
          style="font-size:calc(15px * var(--text-scale, 1));font-weight:600;"
          >Share email and usage data</span
        ><span class="muted sync-row-sub" id="share-s"
          >Still never tracks or monitors the website you visit</span
        >
      </div>
      <Toggle
        checked={state === "on"}
        labelledBy="share-t"
        describedBy="share-s"
        disabled={!onChange || withdrawalHeld}
        onChange={(next) => {
          if (!withdrawalHeld) onChange?.(next);
        }}
      />
    </div>
    {#if state === "off" && withdrawal === "none" && onRequestDeletion}<button
        type="button"
        class="link"
        style="font-size:calc(13px * var(--text-scale, 1));"
        onclick={onRequestDeletion}>Delete data you already shared</button
      >{/if}
    {#if outcome}
      <div
        class="status-line"
        data-tone={outcome.tone}
        role={outcome.tone === "failed" ? "alert" : "status"}
      >
        <span class="glyph"
          ><Glyph
            name={outcome.tone === "pending"
              ? "spinner"
              : outcome.tone === "failed"
                ? "alert"
                : "check"}
            size={16}
          /></span
        >
        <div class="status-body">
          <span>{outcome.text}</span
          >{#if withdrawal === "failed" && onRetry}<button
              type="button"
              class="link status-action"
              onclick={onRetry}>Try again</button
            >{/if}
        </div>
      </div>
    {/if}
  {/if}
</section>
