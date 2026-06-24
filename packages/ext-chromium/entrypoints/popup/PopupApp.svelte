<script lang="ts">
  import { App, type UiController } from "@still/core/ui";

  interface Props {
    controller: UiController;
  }
  let { controller }: Props = $props();

  function openOptions(): void {
    chrome.runtime.openOptionsPage();
  }
</script>

<div class="popup">
  <App {controller} />
  <button class="open-options" onclick={openOptions}>Open settings</button>
</div>

<style>
  .popup {
    inline-size: 340px;
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
</style>
