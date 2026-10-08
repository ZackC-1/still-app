<script lang="ts">
  import MobilePopup from "@still/core/ui/v3/MobilePopup.svelte";
  import type { DesktopPopupProps } from "@still/core/ui/v3/presentation";

  // Firefox for Android shows the toolbar popup as a full-screen overlay, not a small panel, so the
  // shared committed popup host gets the phone presentation there (lib/runtime-platform.ts decides,
  // from the browser's own platform answer). It receives exactly what the desktop popup receives.
  // `browser` and `heroTitle` are desktop-only presentation details MobilePopup does not take.
  //
  // The real options destination is informational; navigation does not verify a payment channel.
  // Permission requests stay on first-run; navigation never invokes a purchase callback.
  let {
    browser: _browser,
    heroTitle: _heroTitle,
    ...presentation
  }: DesktopPopupProps = $props();
</script>

<MobilePopup {...presentation} host="firefox" />
