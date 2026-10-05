<script lang="ts">
  import type { AccessState, FeatureId } from "@still/shared-types";
  import Toggle from "./Toggle.svelte";
  import Glyph from "./Glyph.svelte";

  let {
    id,
    label,
    state: accessState,
    dormant = false,
    checked,
    inactive,
    unsupportedText,
    note,
    onChange,
    onLock,
    lockLabel,
  }: {
    id: FeatureId;
    label: string;
    state: AccessState;
    /** Decision 24: a dormant Still Pro row (paid off) shows the locked design and offers nothing. */
    dormant?: boolean;
    checked: boolean;
    inactive: boolean;
    unsupportedText: string;
    note?: string;
    onChange: (next: boolean) => void;
    onLock?: () => void;
    lockLabel: string;
  } = $props();
  let state = $derived<AccessState>(dormant ? "locked" : accessState);
  let lockAction = $derived(dormant ? undefined : onLock);
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
  let visibleNote = $derived(state === "unsupported" ? unsupportedText : note);
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
    {#if visibleNote}<span class="sub" id={`${key}-s`}>{visibleNote}</span>{/if}
    {#if srNote}<span class="sr-only" id={`${key}-access`}>{srNote}</span>{/if}
  </div>
  {#if usable || state === "checking" || state === "verification_required"}
    <Toggle
      small
      {checked}
      {onChange}
      disabled={inactive || !usable}
      labelledBy={`${key}-l`}
      describedBy={[
        visibleNote ? `${key}-s` : undefined,
        srNote ? `${key}-access` : undefined,
      ]
        .filter(Boolean)
        .join(" ") || undefined}
    />
  {:else if state === "locked"}
    <button
      type="button"
      class="lock-pro"
      aria-label={lockLabel}
      aria-disabled={!lockAction || undefined}
      onclick={lockAction}
      ><Glyph name="lock" size={14} /><span>Still Pro</span></button
    >
  {/if}
</div>
