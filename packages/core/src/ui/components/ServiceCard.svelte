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
    onLockedTap?: () => void;
  }
  let { service, on, onchange, locked = false, onLockedTap }: Props = $props();
  const copy = $derived(STRINGS.services[service]);
</script>

<section class="card" data-service={service} class:locked>
  <ServiceIcon {service} size={42} />
  <div class="text">
    <span class="name">{copy.name}</span>
    <span class="status">{locked ? STRINGS.pro.locked : on ? copy.on : copy.off}</span>
  </div>
  {#if locked}
    <button class="lock" onclick={onLockedTap} aria-label={`${copy.name} — ${STRINGS.pro.locked}`}>
      <span aria-hidden="true">🔒</span>
    </button>
  {:else}
    <Toggle checked={on} label={`Still on ${copy.name}`} {onchange} />
  {/if}
</section>

<style>
  .card {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--surface-raised);
    border-radius: var(--radius-card);
    padding: var(--space-3) var(--space-4);
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-inline-size: 0;
  }
  .name {
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .status {
    font-size: 14px;
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
    opacity: 0.55;
  }
  .lock:hover {
    opacity: 0.85;
  }
</style>
