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
    /* The width is a hard pixel value from the shared token and must stay one. A browser-action
       popup has no predefined viewport: the browser derives the popup window's width FROM the
       rendered content, so anything relative here is circular. `100vw` resolves to ~0 during that
       measurement pass and the popup renders as a one-character-wide sliver; a plain `100%` is the
       same trap, measured at 69px in a real Chrome toolbar popup.

       max-inline-size is the exception, and it is what lets the same popup fit a phone. It is a
       percentage of the containing block rather than of the viewport, which browsers ignore while
       measuring preferred width, so it does not feed back into the popup's own size. On the desktop
       toolbar it resolves to the full 380px and changes nothing (measured). In Safari on iPhone the
       same document is presented as a sheet at the device width, where 380px is 5px too wide on a
       375pt screen and 60px too wide on a 320pt one, and without this the controls on the right
       edge are cut off with no way to scroll to them.

       (Regression guard: popup-width.test.ts, which forbids relative units on the width and
       requires the clamp on the maximum.) */
    inline-size: var(--popup-inline-size, 380px);
    max-inline-size: 100%;
    margin-inline: auto;
    overflow: clip;
  }
</style>
