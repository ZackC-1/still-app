<script lang="ts">
  import { STRINGS } from "../strings.js";
  // The Still placeholder (spec §3.6): a Still Blue field, the dot-on-a-line glyph, one calm line.
  // No buttons, no scolding.
  interface Props {
    line?: string;
  }
  let { line = STRINGS.placeholder }: Props = $props();
</script>

<div class="placeholder" role="status">
  <svg class="glyph" width="64" height="20" viewBox="0 0 64 20" aria-hidden="true">
    <line x1="6" y1="14" x2="58" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    <circle cx="32" cy="14" r="3.2" fill="currentColor" />
  </svg>
  <p class="line">{line}</p>
</div>

<style>
  .placeholder {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    background: var(--still-blue);
    color: var(--on-blue);
    font-family: var(--font-ui);
  }
  .line {
    margin: 0;
    font-size: 16px;
    opacity: 0.92;
  }
</style>
