<script lang="ts">
  import { App } from "@still/core/ui";
  import { createExtensionUiController } from "@still/core/ui";
  import {
    extensionPurchaseDeps,
    restoreHandler,
  } from "../../lib/purchase-wiring.js";
  import { emailConsent } from "../../lib/email-consent.js";
  import { surfaceGuidance } from "../../lib/surface-guidance.js";

  // An extension page like the popup, so it gets the same purchase-spine injection (plan U6):
  // message-closures over the background-owned session, present only when this build carries
  // Supabase config (the fail-safe env gate).
  const purchase = extensionPurchaseDeps();
  const controller = createExtensionUiController(purchase, { emailConsent });
  const onRestore = purchase ? restoreHandler(controller) : undefined;
</script>

<main class="options">
  <App {controller} {onRestore} {surfaceGuidance} />
</main>

<style>
  .options {
    /* The same cap the app content inside already uses, so this frame is exactly as wide as what
       it holds. A wider frame here would be invisible: App.svelte centres itself at
       --content-max-inline-size regardless, so the settings page's real width is that token and
       this reads it rather than offering a second number that changes nothing. */
    max-inline-size: var(--content-max-inline-size, 432px);
    margin-inline: auto;
    padding-block: clamp(var(--space-3), 5vh, var(--space-8));
  }
</style>
