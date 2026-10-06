<script lang="ts">
  // The design system's StatusLine (components/feedback/StatusLine.jsx), drawn with the shared
  // .status-line styles: a tone glyph, the line, and an optional action.
  import Glyph from "@still/core/ui/v3/Glyph.svelte";

  let {
    tone,
    text,
    actionLabel,
    onAction,
  }: {
    tone: "pending" | "success" | "caution" | "failed";
    text: string;
    actionLabel?: string;
    onAction?: () => void;
  } = $props();

  const glyph = $derived(
    tone === "success" ? "check" : tone === "pending" ? "spinner" : "alert",
  );
</script>

<div
  class="status-line"
  data-tone={tone}
  role={tone === "failed" ? "alert" : "status"}
  aria-live={tone === "failed" ? "assertive" : "polite"}
>
  <span class="glyph"><Glyph name={glyph} size={16} /></span>
  <div class="status-body">
    <span>{text}</span>
    {#if actionLabel && onAction}<button
        type="button"
        class="link status-action"
        onclick={onAction}>{actionLabel}</button
      >{/if}
  </div>
</div>
