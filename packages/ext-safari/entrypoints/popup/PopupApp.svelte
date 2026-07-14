<script lang="ts">
  import {
    App,
    SAFARI_SURFACE_GUIDANCE,
    type UiController,
  } from "@still/core/ui";

  interface Props {
    controller: UiController;
  }
  let { controller }: Props = $props();

  function openOptions(): void {
    void browser.runtime.openOptionsPage();
  }
</script>

<div class="popup">
  <App {controller} surfaceGuidance={SAFARI_SURFACE_GUIDANCE} compact />
  <button class="open-options" onclick={openOptions}>Open settings</button>
</div>

<style>
  .popup {
    inline-size: min(380px, 100vw);
    max-inline-size: 100vw;
    margin-inline: auto;
    overflow: clip;
  }
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
