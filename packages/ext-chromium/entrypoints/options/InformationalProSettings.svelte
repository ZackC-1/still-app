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

  const props: ExtensionSettingsProps = $props();
  const deps = bound;
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

  // Signed in, Restore is the scoped re-check; signed out it needs the normal sign-in first.
  let onRestore = $derived(
    flow && deps && (deps.controller.userId || deps.controller.canSignIn)
      ? () => flow.restore()
      : undefined,
  );
  let pro = $derived.by((): ExtensionSettingsProps["pro"] => {
    if (ownership === "hidden") return undefined;
    // Purchased: the settings page shows "Purchased" in its Still Pro and sync card.
    if (ownership === "owned") return { ownership: "owned", channel: "unverified" };
    if (ownership === "verify") return { ownership: "verify", channel: "unverified", onRestore };
    if (ownership === "checking" || flowState.channel === "checking")
      return { ownership: "checking", channel: "unverified", onRestore };
    if (!flow || flowState.channel !== "ready")
      return { ownership: "none", channel: "unverified", onRestore };
    // Known none, and the background says this build may sell here: Buy with no price on this
    // surface (the checkout page shows it).
    return {
      ownership: "none",
      channel: "ready",
      offer: { price: "", checkoutPriced: true },
      state:
        flowState.purchase === "opening" || flowState.purchase === "waiting"
          ? "pending"
          : flowState.purchase === "failed"
            ? "failed"
            : "idle",
      onBuy: () => flow.buy(),
      onSignIn: deps?.controller.canSignIn ? () => deps.controller.openSignIn() : undefined,
      onRestore,
      onRetry: () => flow.retry(),
    };
  });
</script>

<!-- Keep the approved compact card; the existing full purchase view owns the inventory. -->
<ExtensionSettings {...props} {pro} restore={flowState.restore} />
