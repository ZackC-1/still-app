<script lang="ts">
  import type { ServiceId } from "@still/shared-types";
  import Toggle from "./Toggle.svelte";
  import ServiceIcon from "./ServiceIcon.svelte";
  import { STRINGS } from "../strings.js";

  interface Props {
    service: ServiceId;
    on: boolean;
    onchange: () => void;
    /** Pro-gated service for an un-entitled user: the toggle is replaced by a lock that opens the
     * paywall — a flippable toggle here would change nothing on the page (the engine gates it). */
    locked?: boolean;
    disabled?: boolean;
    onLockedTap?: () => void;
  }
  let {
    service,
    on,
    onchange,
    locked = false,
    disabled = false,
    onLockedTap,
  }: Props = $props();
  const copy = $derived(STRINGS.services[service]);
</script>

<section class="card" data-service={service} class:locked>
  <ServiceIcon {service} size={42} />
  <div class="text">
    <span class="name">{copy.name}</span>
    <span class="status"
      >{locked ? STRINGS.pro.locked : on ? copy.on : copy.off}</span
    >
  </div>
  {#if locked}
    <button
      class="lock"
      {disabled}
      onclick={onLockedTap}
      aria-label={`${copy.name} — ${STRINGS.pro.locked}`}
    >
      <svg
        viewBox="0 0 20 22"
        width="18"
        height="20"
        fill="none"
        aria-hidden="true"
      >
        <rect
          x="3"
          y="9"
          width="14"
          height="10"
          rx="3"
          stroke="currentColor"
          stroke-width="1.8"
        />
        <path
          d="M6 9V6a4 4 0 0 1 8 0v3"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
      </svg>
    </button>
  {:else}
    <Toggle
      checked={on}
      label={`Still on ${copy.name}`}
      {disabled}
      {onchange}
    />
  {/if}
</section>

<style>
  .card {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--surface-raised);
    border-radius: var(--radius-card);
    padding: var(--service-card-padding-block, var(--space-3))
      var(--service-card-padding-inline, var(--space-4));
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-inline-size: 0;
  }
  .name {
    font-size: var(--service-name-size, 17px);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .status {
    font-size: var(--service-status-size, 14px);
    color: var(--ink-secondary);
  }
  .card.locked .name {
    color: var(--ink-secondary);
  }
  .lock {
    background: transparent;
    border: none;
    font-size: 18px;
    line-height: 1;
    padding: var(--space-2);
    cursor: pointer;
    color: var(--ink-secondary);
    opacity: 0.72;
  }
  .lock:hover {
    opacity: 1;
  }
  .lock:disabled {
    cursor: not-allowed;
  }
</style>
