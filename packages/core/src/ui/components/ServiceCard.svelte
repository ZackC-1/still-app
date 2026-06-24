<script lang="ts">
  import type { ServiceId } from "@still/shared-types";
  import Toggle from "./Toggle.svelte";
  import SettingsRow from "./SettingsRow.svelte";
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
  <SettingsRow label={copy.name} secondary={on ? copy.on : copy.off}>
    {#snippet control()}
      <Toggle checked={on} label={`Still on ${copy.name}`} {onchange} />
    {/snippet}
  </SettingsRow>
</section>

<style>
  .card {
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
  }
</style>
