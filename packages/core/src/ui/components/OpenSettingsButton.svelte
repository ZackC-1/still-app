<script lang="ts">
  import type { SurfaceGuidance } from "../surface-guidance.js";

  interface Props {
    /** Appended to the accessible name so screen readers hear where Still lives on this surface. */
    surfaceGuidance: SurfaceGuidance;
    onOpen: () => void;
  }
  let { surfaceGuidance, onOpen }: Props = $props();
</script>

<!-- The accessible name starts with the exact visible text (WCAG 2.5.3 Label in Name). -->
<button
  class="open-options"
  aria-label={`Open settings & setup guide. ${surfaceGuidance.title}.`}
  onclick={onOpen}
>
  Open settings &amp; setup guide
</button>

<style>
  .open-options {
    display: block;
    inline-size: 100%;
    background: transparent;
    border: none;
    border-block-start: 1px solid var(--border);
    color: var(--still-blue);
    font: inherit;
    padding: var(--space-3);
    cursor: pointer;
  }
  .open-options:hover {
    background: var(--surface-raised);
    color: var(--still-blue-pressed);
  }
  .open-options:focus-visible {
    /* Inward: the popup's overflow clip would swallow the outward outline of this flush button. */
    outline-offset: -3px;
  }
</style>
