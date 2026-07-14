<script lang="ts">
  import {
    App,
    OpenSettingsButton,
    type SurfaceGuidance,
    type UiController,
  } from "@still/core/ui";

  interface Props {
    controller: UiController;
    /** Web restore = a fresh authenticated reconcile (plan U5/U6). Absent on builds without the
     * purchase spine — the paywall then renders its explanatory state with no live buttons. */
    onRestore?: () => void;
    surfaceGuidance: SurfaceGuidance;
  }
  let { controller, onRestore, surfaceGuidance }: Props = $props();

  function openOptions(): void {
    chrome.runtime.openOptionsPage();
  }
</script>

<div class="popup">
  <App {controller} {onRestore} compact />
  <OpenSettingsButton {surfaceGuidance} onOpen={openOptions} />
</div>

<style>
  .popup {
    inline-size: min(380px, 100vw);
    max-inline-size: 100vw;
    margin-inline: auto;
    overflow: clip;
  }
</style>
