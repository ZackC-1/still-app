<script lang="ts">
  import { App } from "@still/core/ui";
  import { createExtensionUiController } from "@still/core/ui";

  // The options page has no single active host, so the per-site pause control is omitted.
  const controller = createExtensionUiController();
</script>

<main class="options">
  <App {controller} />
</main>

<style>
  .options {
    max-inline-size: 480px;
    margin-inline: auto;
    padding-block: var(--space-8);
  }
</style>
