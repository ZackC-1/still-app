<script lang="ts">
  import { App } from "@still/core/ui";
  import { createExtensionUiController } from "@still/core/ui";
  import { extensionPurchaseDeps, restoreHandler } from "../../lib/purchase-wiring.js";

  // The options page has no single active host, so the per-site pause control is omitted. It is
  // an extension page like the popup, so it gets the same purchase-spine injection (plan U6):
  // message-closures over the background-owned session, present only when this build carries
  // Supabase config (the fail-safe env gate).
  const purchase = extensionPurchaseDeps();
  const controller = createExtensionUiController(undefined, purchase);
  const onRestore = purchase ? restoreHandler(controller) : undefined;
</script>

<main class="options">
  <App {controller} {onRestore} />
</main>

<style>
  .options {
    max-inline-size: 480px;
    margin-inline: auto;
    padding-block: var(--space-8);
  }
</style>
