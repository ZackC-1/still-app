<script lang="ts">
  import { trapFocus } from "../focus-trap.js";
  import type { ConfirmationDialogProps } from "./extension-settings-presentation.js";
  let {
    open,
    title,
    body,
    confirmLabel,
    tone = "danger",
    cancelLabel = "Cancel",
    onConfirm,
    onCancel,
  }: ConfirmationDialogProps = $props();
  let node: HTMLDivElement | undefined = $state();
  let cancel: HTMLButtonElement | undefined = $state();
  let id = $derived("dlg-" + title.replace(/\W+/g, "-").toLowerCase());
  $effect(() => {
    if (!open || !node || !cancel) return;
    const teardown = trapFocus({
      container: () => node,
      focusable:
        'button:not([disabled]),a[href],input:not([disabled]),[tabindex]:not([tabindex="-1"])',
      onDismiss: () => onCancel(),
    });
    cancel.focus({ preventScroll: true });
    return teardown;
  });
</script>

{#if open}
  <div class="scrim" role="presentation" onclick={onCancel}></div>
  <div
    bind:this={node}
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby={`${id}-t`}
    aria-describedby={body ? `${id}-b` : undefined}
  >
    <h2 id={`${id}-t`}>{title}</h2>
    {#if body}<p class="body" id={`${id}-b`}>{body}</p>{/if}
    <div class="dialog-actions">
      <button
        type="button"
        class={tone === "danger" ? "danger-solid" : "primary"}
        disabled={!onConfirm}
        onclick={onConfirm}>{confirmLabel}</button
      >
      <button
        bind:this={cancel}
        type="button"
        class="secondary"
        data-autofocus=""
        onclick={onCancel}>{cancelLabel}</button
      >
    </div>
  </div>
{/if}
