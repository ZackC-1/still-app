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
    host = "browser",
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
    /**
     * The locked row's host-owned destination. It never starts a purchase in this row.
     * Hosts supply it only while the actual Still Pro destination is available.
     */
    onLock?: (opener: HTMLElement) => void;
    host?: "browser" | "safari";
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
  // CH-96 (owner, 21 Oct, option C): after a refund the saved choice stays visible. A locked row
  // draws its saved switch, dimmed and in its saved position, beside the lock; it changes nothing
  // while locked, and the saved position applies again when Still Pro returns. A dormant row (paid
  // tier off) keeps the lock alone (decision 24).
  let savedShown = $derived(state === "locked" && !dormant);
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
    {#if savedShown}<span class="sr-only" id={`${key}-locked`}
        >Included in Still Pro. Your choice is saved.</span
      >{/if}
    <span class="locked-controls">
    <button
      type="button"
      class="lock-pro"
      aria-label={`${label}. Included in Still Pro.${lockAction ? ` ${host === "safari" ? "Open the Still app" : "See Still Pro"}` : ""}`}
      aria-describedby={[`${key}-l`, visibleNote ? `${key}-s` : undefined]
        .filter(Boolean)
        .join(" ")}
      aria-disabled={!lockAction || undefined}
      onclick={lockAction
        ? (event) => lockAction?.(event.currentTarget as HTMLElement)
        : undefined}
      ><Glyph name="lock" size={14} /><span>Still Pro</span></button
    >
    {#if savedShown}<Toggle
        small
        {checked}
        disabled
        labelledBy={`${key}-l`}
        describedBy={`${key}-locked`}
      />{/if}
    </span>
  {/if}
</div>

<style>
  .locked-controls {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2, 8px);
  }
</style>
