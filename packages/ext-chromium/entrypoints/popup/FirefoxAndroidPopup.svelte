<script lang="ts">
  import MobilePopup from "@still/core/ui/v3/MobilePopup.svelte";
  import type { DesktopPopupProps } from "@still/core/ui/v3/presentation";

  // Firefox for Android shows the toolbar popup as a full-screen overlay, not a small panel, so the
  // shared committed popup host gets the phone presentation there (lib/runtime-platform.ts decides,
  // from the browser's own platform answer). It receives exactly what the desktop popup receives.
  // `browser` and `heroTitle` are desktop-only presentation details MobilePopup does not take.
  //
  // No purchase channel and no setup card are supplied: `channelReady` stays false until the actual
  // Firefox Android managed channel is verified, and the permission request lives on the first-run
  // page. Every visible word comes from MobilePopup's existing `host: "firefox"` presentation.
  let {
    browser: _browser,
    heroTitle: _heroTitle,
    ...presentation
  }: DesktopPopupProps = $props();
</script>

<MobilePopup {...presentation} host="firefox" />
