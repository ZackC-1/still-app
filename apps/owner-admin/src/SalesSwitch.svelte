<script lang="ts">
  // The sales switch. Remote sales is only the second key: packaged builds AND it with their
  // compiled paid switch, which stays off. The server refuses to turn sales on while the paid cutoff
  // is not enabled (R4); that refusal is shown as it is, and nothing changes. Wording that the
  // approved references don't cover is PENDING_OWNER_COPY.
  import Toggle from "@still/core/ui/v3/Toggle.svelte";
  import StatusLine from "./StatusLine.svelte";
  import { APPROVED, PENDING_OWNER_COPY } from "./copy.js";
  import type { SalesModel } from "./policy-model.js";
  import { isBusy, type SectionState } from "./section-state.js";

  let {
    current,
    revision,
    phase = "idle",
    onApply,
    onRollback,
    onStatusAction,
    onEdit,
  }: {
    current: SalesModel;
    revision: number;
    phase?: SectionState;
    onApply: (draft: SalesModel) => void;
    onRollback?: () => void;
    onStatusAction: (state: SectionState, draft: SalesModel) => void;
    onEdit?: () => void;
  } = $props();

  const shared = APPROVED.allowances;
  const pending = PENDING_OWNER_COPY;
  let edited = $state<SalesModel | null>(null);
  const draft = $derived(edited ?? current);
  const changed = $derived(draft.on !== current.on);
  const busy = $derived(isBusy(phase));

  export function reset() {
    edited = null;
  }

  const line = $derived.by(() => {
    switch (phase) {
      case "applying": return { tone: "pending" as const, text: shared.applying };
      case "readback": return { tone: "pending" as const, text: pending.salesReadback };
      case "applied": return { tone: "success" as const, text: shared.applied };
      case "stale": return { tone: "caution" as const, text: shared.stale, action: shared.reload };
      case "failed": return { tone: "failed" as const, text: shared.failed, action: shared.tryAgain };
      case "cutoff-refused": return { tone: "failed" as const, text: pending.salesCutoffRefused };
      case "unconfirmed": return { tone: "caution" as const, text: pending.unconfirmed, action: shared.reload };
      default: return null;
    }
  });
</script>

<section class="card card-stack" aria-label={pending.salesTitle} data-revision={revision}>
  <div class="heading">
    <h2 class="card-title">{pending.salesTitle}</h2>
    <p class="card-body small">{pending.salesBody}</p>
  </div>
  {#if current.builds.length === 0}<p class="caption" role="note">{pending.noBuilds}</p>{/if}
  <div class="allow-list">
    <div class="allow-row">
      <div class="row-main">
        <span class="label"
          ><span id="sales-switch">{pending.salesSwitch}</span>{#if changed}<span class="access-tag boxed"
              >{shared.changed}</span
            >{/if}</span
        >
      </div>
      <Toggle
        small
        checked={draft.on}
        disabled={busy}
        labelledBy="sales-switch"
        onChange={(v) => {
          edited = { ...draft, on: v };
          onEdit?.();
        }}
      />
    </div>
  </div>
  {#if line}
    <StatusLine
      tone={line.tone}
      text={line.text}
      actionLabel={line.action}
      onAction={() => onStatusAction(phase, draft)}
    />
  {/if}
  <div class="inline-actions">
    <button
      type="button"
      class="primary inline"
      disabled={!changed || busy}
      onclick={() => onApply(draft)}>{shared.apply}</button
    >
    {#if changed && !busy}
      <button type="button" class="link" onclick={() => { edited = null; onEdit?.(); }}>{shared.discard}</button>
    {:else if onRollback && revision >= 2 && !busy}
      <button type="button" class="link" onclick={onRollback}>{pending.rollback}</button>
    {/if}
  </div>
</section>

<style>
  .heading { display: flex; flex-direction: column; gap: 2px; }
  .small { font-size: calc(13px * var(--text-scale, 1)); }
</style>
