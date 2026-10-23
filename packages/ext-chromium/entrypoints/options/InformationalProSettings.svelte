<script module lang="ts">
  import type { BrowserProDeps } from "../../lib/browser-pro.js";

  let bound: BrowserProDeps | undefined;

  /**
   * Called by the options page each time it loads this wrapper (paid-tier builds only), with its
   * controller and the background-backed checkout seam when the build has the sign-in spine, and
   * undefined otherwise. Unbound, the card stays informational: no Buy and no Restore.
   */
  export function bindBrowserPro(deps: BrowserProDeps | undefined): void {
    bound = deps;
  }
</script>

<script lang="ts">
  import ExtensionSettings from "@still/core/ui/v3/ExtensionSettings.svelte";
  import type { ExtensionSettingsProps } from "@still/core/ui/v3/extension-settings-presentation";
  import {
    createBrowserPro,
    INITIAL_BROWSER_PRO_STATE,
    proOwnership,
    type BrowserProState,
  } from "../../lib/browser-pro.js";
  import { useSiteAccessCard } from "../../lib/site-access-card.svelte.js";
  import { stillProPriceLine } from "../../lib/still-pro-price.js";

  const props: ExtensionSettingsProps = $props();
  const deps = bound;
  // ISS-0037: warn at the top when the browser withholds Still's four sites, with Allow.
  const siteAccess = useSiteAccessCard();
  let flowState = $state.raw<BrowserProState>(INITIAL_BROWSER_PRO_STATE);
  const flow = deps
    ? createBrowserPro(deps, (next) => {
        flowState = next;
      })
    : undefined;
  // The committed access observation is the only authority. Historical Boolean entitlements,
  // a reconcile's own answer and the existence of a navigation destination cannot verify Pro.
  let ownership = $derived(proOwnership(props.access));
  $effect(() => {
    flow?.observe({
      userId: deps?.controller.userId ?? null,
      signInOpen: deps?.controller.signInOpen ?? false,
      ownership,
    });
  });
  $effect(() => () => flow?.stop());
  let hostRoot = $state<HTMLDivElement>();
  let offerReported = false;
  // The inline settings card is itself the browser offer. Count it once per page only when a
  // sellable card actually enters the visible viewport; loading Settings is not an impression.
  $effect(() => {
    if (!hostRoot || !deps?.analytics || offerReported || ownership !== "none" || flowState.channel !== "ready"
        || typeof IntersectionObserver === "undefined") return;
    const card = hostRoot.querySelector('section[aria-label="Still Pro"]');
    if (!card) return;
    let live = true;
    let inView = false;
    const report = () => {
      if (!live || offerReported || !inView || document.visibilityState !== "visible") return;
      offerReported = true;
      try { deps.analytics?.track("paywall_viewed", { trigger: "settings_card", where: "options" }); } catch { /* Optional measurement. */ }
    };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.target === card) inView = entry.isIntersecting;
      report();
    });
    observer.observe(card);
    document.addEventListener("visibilitychange", report);
    return () => {
      live = false;
      observer.disconnect();
      document.removeEventListener("visibilitychange", report);
    };
  });

  // Signed in, Restore is the scoped re-check; signed out it needs the normal sign-in first.
  let onRestore = $derived(
    flow && deps && (deps.controller.userId || deps.controller.canSignIn)
      ? () => flow.restore()
      : undefined,
  );
  let pro = $derived.by((): ExtensionSettingsProps["pro"] => {
    if (ownership === "hidden") return undefined;
    // Purchased: the settings page shows its Still Pro card as "Purchased", beside the sync card.
    if (ownership === "owned") return { ownership: "owned", channel: "unverified" };
    // A known none going stale is renewed quietly (ISS-0072): "verify again" only if that fails.
    if (ownership === "verify" && flowState.renewing)
      return { ownership: "checking", channel: "unverified", onRestore };
    // Gone stale while offline, the known none is kept (ISS-0090): Still can't check right now.
    if (ownership === "verify" && flowState.offlineNone)
      return { ownership: "none", channel: "offline", onRestore };
    if (ownership === "verify") return { ownership: "verify", channel: "unverified", onRestore };
    if (ownership === "checking" || flowState.channel === "checking")
      return { ownership: "checking", channel: "unverified", onRestore };
    if (!flow || flowState.channel !== "ready")
      return {
        ownership: "none",
        channel: flowState.channel === "offline" ? "offline" : "unverified",
        onRestore,
      };
    // Known none, and the background says this build may sell here: Buy, with the configured price
    // line for the reviewed offer under it when one is configured (owner, 21 Oct), else nothing.
    const priceLine = stillProPriceLine();
    return {
      ownership: "none",
      channel: "ready",
      offer: { price: "", checkoutPriced: true, ...(priceLine ? { priceLine } : {}) },
      state:
        flowState.purchase === "opening" || flowState.purchase === "waiting"
          ? "pending"
          : flowState.purchase === "failed"
            ? "failed"
            : "idle",
      onBuy: () => flow.buy(),
      // Get Still Pro, signed out: the purchase sign-in (ISS-0123), not the settings-sync one.
      onSignIn: deps?.controller.canSignIn ? () => deps.controller.openSignIn("purchase") : undefined,
      onRestore,
      onRetry: () => flow.retry(),
    };
  });
</script>

<!-- Keep the approved compact card; the existing full purchase view owns the inventory. -->
<div bind:this={hostRoot} style="display: contents">
<ExtensionSettings
  {...props}
  {pro}
  proReturnGuidance={props.phone ? "To return to Still’s controls, open a website, then choose Firefox’s three-dot menu → Extensions → Still." : undefined}
  restore={flowState.restore}
  siteAccess={siteAccess.current}
/>
</div>
