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
    /* Fixed px — NEVER a viewport unit here. A browser-action popup has no predefined viewport:
       the browser derives the popup window's width FROM the rendered content, so `100vw` resolves
       to ~0 during that measurement pass, `min(380px, 100vw)` collapses to 0, and the whole popup
       renders as a one-character-wide sliver. A hard pixel width is the only reliable way to size a
       popup. (Regression guard: popup-width.test.ts forbids vw units on this rule.) */
    inline-size: 380px;
    margin-inline: auto;
    overflow: clip;
  }
</style>
