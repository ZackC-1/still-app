<script lang="ts">
  import type { AccessState, FeatureId } from "@still/shared-types";
  import Toggle from "./Toggle.svelte";
  import Glyph from "./Glyph.svelte";

  let {
    id,
    label,
    state,
    checked,
    inactive,
    unsupportedText,
    onChange,
    onLock,
    lockLabel,
  }: {
    id: FeatureId;
    label: string;
    state: AccessState;
    checked: boolean;
    inactive: boolean;
    unsupportedText: string;
    onChange: (next: boolean) => void;
    onLock?: () => void;
    lockLabel: string;
  } = $props();
  let usable = $derived(
    state === "free" || state === "purchased" || state === "protected",
  );
  let key = $derived(id.replace(/\W+/g, "-"));
  let srNote = $derived(
    state === "checking"
      ? "Checking your Still Pro access. Your choice is saved."
      : state === "verification_required"
        ? "Verify Still Pro to use this. Your choice is saved."
        : undefined,
  );
</script>

<div
  class="option-row"
  data-access={state === "verification_required" ? "verify" : state}
  data-inactive={inactive ||
    state === "unsupported" ||
    state === "locked" ||
    undefined}
>
  <div class="row-main">
    <span class="label"><span id={`${key}-l`}>{label}</span></span>
    {#if state === "unsupported"}
      <span class="sub" id={`${key}-s`}>{unsupportedText}</span>
    {:else if srNote}
      <span class="sr-only" id={`${key}-s`}>{srNote}</span>
    {/if}
  </div>
  {#if usable || state === "checking" || state === "verification_required"}
    <Toggle
      small
      {checked}
      {onChange}
      disabled={inactive || !usable}
      labelledBy={`${key}-l`}
      describedBy={srNote ? `${key}-s` : undefined}
    />
  {:else if state === "locked"}
    <button
      type="button"
      class="lock-pro"
      aria-label={lockLabel}
      aria-disabled={!onLock || undefined}
      onclick={onLock}
      ><Glyph name="lock" size={14} /><span>Still Pro</span></button
    >
  {/if}
</div>
