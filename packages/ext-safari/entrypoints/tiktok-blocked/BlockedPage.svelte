<script lang="ts">
  import { onMount, untrack } from "svelte";
  import TikTokBlocked from "@still/core/ui/v3/TikTokBlocked.svelte";
  import type { createTikTokBlockedHost } from "@still/core/ui/v3/tiktok-blocked-host";
  import { safariPopupSurface, type SafariPopupSurface } from "../../lib/safari-v3.js";
  let { host, readPlatform }: {
    host: ReturnType<typeof createTikTokBlockedHost>;
    readPlatform: () => Promise<string | undefined>;
  } = $props();
  let presentation = $state.raw(untrack(() => host.current()));
  let surface = $state<SafariPopupSurface>("mobile");
  onMount(() => {
    let living = true;
    const retire = () => { living = false; };
    const unsubscribe = host.subscribe((next) => { presentation = next; });
    window.addEventListener("pagehide", retire, { once: true });
    // This selects only settings guidance; platform never establishes tab or native authority.
    void Promise.resolve().then(readPlatform).then((os) => {
      if (living) surface = safariPopupSurface(os);
    }).catch(() => {});
    return () => { retire(); unsubscribe(); window.removeEventListener("pagehide", retire); };
  });
</script>
<TikTokBlocked presentation={{ ...presentation, host: surface === "desktop" ? "browser" : "ios" }} />
