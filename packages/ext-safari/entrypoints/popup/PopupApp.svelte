<script lang="ts">
  import {
    App,
    OpenSettingsButton,
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
  <App {controller} compact />
  <OpenSettingsButton
    surfaceGuidance={SAFARI_SURFACE_GUIDANCE}
    onOpen={openOptions}
  />
</div>

<style>
  .popup {
    inline-size: min(380px, 100vw);
    max-inline-size: 100vw;
    margin-inline: auto;
    overflow: clip;
  }
</style>
