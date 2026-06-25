<script lang="ts">
  import type { ServiceId } from "@still/shared-types";
  import Toggle from "./Toggle.svelte";
  import ServiceIcon from "./ServiceIcon.svelte";
  import { STRINGS } from "../strings.js";

  interface Props {
    service: ServiceId;
    on: boolean;
    onchange: () => void;
  }
  let { service, on, onchange }: Props = $props();
  const copy = $derived(STRINGS.services[service]);
</script>

<section class="card" data-service={service}>
  <ServiceIcon {service} size={42} />
  <div class="text">
    <span class="name">{copy.name}</span>
    <span class="status">{on ? copy.on : copy.off}</span>
  </div>
  <Toggle checked={on} label={`Still on ${copy.name}`} {onchange} />
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
</style>
