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
  // ISS-0122 (owner, 22 Oct; supersedes CH-96 option C): while Still Pro is not owned a locked row
  // shows no switch, only its name and the Still Pro chip, on one line, on every surface, after a
  // refund too. The saved choice stays in storage untouched (this row never writes) and applies
  // again when Still Pro returns, when the row is usable and draws its switch again.
</script>

<div
  class="option-row"
  data-access={state === "verification_required" ? "verify" : state}
  data-inactive={inactive ||
    state === "unsupported" ||
    dormant ||
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
    <!-- The bordered Still Pro chip at the row's end (owner canvas, P-Sites). A dormant row (paid
      tier off, decision 24) gets the same chip, inert. -->
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
  {/if}
</div>

