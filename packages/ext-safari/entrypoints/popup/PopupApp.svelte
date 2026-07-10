<script lang="ts">
  import { App, type UiController } from "@still/core/ui";

  interface Props {
    controller: UiController;
  }
  let { controller }: Props = $props();

  function openOptions(): void {
    void browser.runtime.openOptionsPage();
  }
</script>

<div class="popup">
  <App {controller} compact />
  <button class="open-options" onclick={openOptions}>Open settings</button>
</div>

<style>
  .popup {
    inline-size: min(380px, 100vw);
    max-inline-size: 100vw;
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
</style>
