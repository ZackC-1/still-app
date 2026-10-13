<script lang="ts">
  // Test-only host for useSiteAccessCard with injected browser ports.
  import SiteAccessCard from "../../../../core/src/ui/v3/SiteAccessCard.svelte";
  import {
    useSiteAccessCard,
    type SiteAccessCardPorts,
  } from "../../../lib/site-access-card.svelte.js";
  let { ports }: { ports: () => SiteAccessCardPorts } = $props();
  const siteAccess = useSiteAccessCard(ports);
</script>

{#if siteAccess.current}<SiteAccessCard {...siteAccess.current} />{/if}
