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
  aria-label={`Settings & setup guide. ${surfaceGuidance.title}.`}
  onclick={onOpen}
>
  Settings &amp; setup guide
</button>

<style>
  /* A text link in the compact popup's footer, beside the privacy policy link. */
  .open-options {
    background: transparent;
    border: none;
    color: var(--still-blue);
    font: inherit;
    padding: 0;
    cursor: pointer;
    text-align: start;
  }
  .open-options:hover {
    color: var(--still-blue-pressed);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
