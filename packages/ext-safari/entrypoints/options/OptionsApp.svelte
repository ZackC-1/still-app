<script lang="ts">
  import { App } from "@still/core/ui";
  import { createExtensionUiController } from "@still/core/ui";
  import { pushSettingsToApp } from "../../lib/native-settings.js";

  // Push each local edit straight to the App Group (see popup/main.ts — the background reconciler
  // may be asleep on iOS and miss the browser.storage write).
  void browser.runtime.sendMessage({ kind: "reconcile" }).catch(() => {});

  const controller = createExtensionUiController(undefined, {
    onLocalSettingsCommit: (record) => void pushSettingsToApp(record),
  });
</script>

<main class="options">
  <App {controller} />
</main>

<style>
  .options {
    max-inline-size: 480px;
    margin-inline: auto;
    padding-block: clamp(var(--space-3), 5vh, var(--space-8));
  }
</style>
