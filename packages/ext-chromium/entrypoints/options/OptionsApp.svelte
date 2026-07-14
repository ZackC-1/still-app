<script lang="ts">
  import { App } from "@still/core/ui";
  import { createExtensionUiController } from "@still/core/ui";
  import {
    extensionPurchaseDeps,
    restoreHandler,
  } from "../../lib/purchase-wiring.js";
  import { surfaceGuidance } from "../../lib/surface-guidance.js";

  // An extension page like the popup, so it gets the same purchase-spine injection (plan U6):
  // message-closures over the background-owned session, present only when this build carries
  // Supabase config (the fail-safe env gate).
  const purchase = extensionPurchaseDeps();
  const controller = createExtensionUiController(purchase);
  const onRestore = purchase ? restoreHandler(controller) : undefined;
</script>

<main class="options">
  <App {controller} {onRestore} {surfaceGuidance} />
</main>

<style>
  .options {
    max-inline-size: 480px;
    margin-inline: auto;
    padding-block: clamp(var(--space-3), 5vh, var(--space-8));
  }
</style>
