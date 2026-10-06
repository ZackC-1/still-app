<script lang="ts">
  // D28 OwnerAllowances (design system v3.2, components/engagement/OwnerAllowances.jsx), ported to
  // Svelte with the approved copy. Master Off keeps the surface choices; Edge is shown as Deferred
  // and has no switch; nothing changes until Apply, and success is shown only after readback.
  import Toggle from "@still/core/ui/v3/Toggle.svelte";
  import StatusLine from "./StatusLine.svelte";
  import { APPROVED } from "./copy.js";
  import {
    changedAllowances,
    isDeferred,
    liveSurfaces,
    SURFACES,
    type AllowanceKey,
    type RatingModel,
    type Surface,
  } from "./policy-model.js";
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
    current: RatingModel;
    revision: number;
    phase?: SectionState;
    onApply: (draft: RatingModel) => void;
    onRollback?: () => void;
    onStatusAction: (state: SectionState, draft: RatingModel) => void;
    onEdit?: () => void;
  } = $props();

  const copy = APPROVED.allowances;
  let edited = $state<RatingModel | null>(null);
  const draft = $derived(edited ?? current);
  const changed = $derived(changedAllowances(current, draft));
  const busy = $derived(isBusy(phase));
  const live = $derived(liveSurfaces(draft).map((s) => APPROVED.surfaces[s]));

  /** Called by the page after a verified apply or a reload: the draft is the server state again. */
  export function reset() {
    edited = null;
  }

  function set(key: AllowanceKey, value: boolean) {
    edited =
      key === "global"
        ? { ...draft, master: value }
        : { ...draft, surfaces: { ...draft.surfaces, [key]: value } };
    onEdit?.();
  }
  const isOn = (key: AllowanceKey) => (key === "global" ? draft.master : draft.surfaces[key as Surface]);

  const line = $derived.by(() => {
    switch (phase) {
      case "applying": return { tone: "pending" as const, text: copy.applying };
      case "readback": return { tone: "pending" as const, text: copy.readback };
      case "applied": return { tone: "success" as const, text: copy.applied };
      case "stale": return { tone: "caution" as const, text: copy.stale, action: copy.reload };
      case "failed": return { tone: "failed" as const, text: copy.failed, action: copy.tryAgain };
      case "unconfirmed": return { tone: "caution" as const, text: APPROVED.unconfirmed, action: copy.reload };
      default: return null;
    }
  });
  const rows = $derived<{ id: AllowanceKey; name: string; deferred: boolean; inactive: boolean }[]>([
    { id: "global", name: copy.all, deferred: false, inactive: false },
    ...SURFACES.map((s) => ({ id: s, name: APPROVED.surfaces[s], deferred: isDeferred(s), inactive: !draft.master })),
  ]);
</script>

<section class="card card-stack" aria-label={copy.title} data-revision={revision}>
  <div class="heading">
    <h2 class="card-title">{copy.title}</h2>
    <p class="card-body small">{copy.body}</p>
  </div>
  {#if current.builds.length === 0}<p class="caption" role="note">{APPROVED.noBuilds}</p>{/if}
  <div class="allow-list">
    {#each rows as row (row.id)}
      <div class="allow-row" data-inactive={row.inactive || undefined}>
        <div class="row-main">
          <span class="label"
            ><span id={"al-" + row.id}>{row.name}</span>{#if row.deferred}<span class="access-tag boxed"
                >{copy.deferred}</span
              >{:else if changed.includes(row.id)}<span class="access-tag boxed">{copy.changed}</span>{/if}</span
          >
        </div>
        {#if !row.deferred}
          <Toggle
            small
            checked={isOn(row.id)}
            disabled={busy}
            labelledBy={"al-" + row.id}
            onChange={(v) => set(row.id, v)}
          />
        {/if}
      </div>
    {/each}
  </div>
  <p class="allow-preview">
    {copy.previewLead}<strong>{live.length ? live.join(", ") : copy.previewNone}</strong>.
  </p>
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
      disabled={!changed.length || busy}
      onclick={() => onApply(draft)}>{copy.apply}</button
    >
    {#if changed.length > 0 && !busy}
      <button type="button" class="link" onclick={() => { edited = null; onEdit?.(); }}>{copy.discard}</button>
    {:else if onRollback && revision >= 2 && !busy}
      <button type="button" class="link" onclick={onRollback}>{APPROVED.rollback}</button>
    {/if}
  </div>
</section>

<style>
  .heading { display: flex; flex-direction: column; gap: 2px; }
  .small { font-size: calc(13px * var(--text-scale, 1)); }
</style>
