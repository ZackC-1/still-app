<script lang="ts">
  import MobilePopup from "@still/core/ui/v3/MobilePopup.svelte";
  import type { DesktopPopupProps } from "@still/core/ui/v3/presentation";
  import { useSiteAccessCard } from "../../lib/site-access-card.svelte.js";

  // Firefox for Android shows the toolbar popup as a full-screen overlay, not a small panel, so the
  // shared committed popup host gets the phone presentation there (lib/runtime-platform.ts decides,
  // from the browser's own platform answer). It receives exactly what the desktop popup receives.
  // `browser` and `heroTitle` are desktop-only presentation details MobilePopup does not take.
  //
  // The real options destination is informational; navigation does not verify a payment channel.
  // Navigation never invokes a purchase callback. The one permission request here is the site
  // access warning's Allow (ISS-0037), for the same four declared sites the first-run page asks for.
  let {
    browser: _browser,
    heroTitle: _heroTitle,
    ...presentation
  }: DesktopPopupProps = $props();
  const siteAccess = useSiteAccessCard();
</script>

<MobilePopup {...presentation} host="firefox" siteAccess={siteAccess.current} />
