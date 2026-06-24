<script lang="ts">
  import type { Snippet } from "svelte";
  interface Props {
    label: string;
    secondary?: string;
    control?: Snippet;
  }
  let { label, secondary, control }: Props = $props();
</script>

<div class="row">
  <div class="text">
    <span class="label">{label}</span>
    {#if secondary}<span class="secondary">{secondary}</span>{/if}
  </div>
  {#if control}<div class="control">{@render control()}</div>{/if}
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }
  .label {
    font-size: 16px;
    font-weight: 500;
  }
  .secondary {
    font-size: 14px;
    color: var(--ink-secondary);
  }
</style>
