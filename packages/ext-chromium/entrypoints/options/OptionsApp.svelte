<script lang="ts">
  import { App } from "@still/core/ui";
  import { createUiController } from "../../lib/setup";

  // The options page has no single active host, so the per-site pause control is omitted.
  const controller = createUiController();
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
