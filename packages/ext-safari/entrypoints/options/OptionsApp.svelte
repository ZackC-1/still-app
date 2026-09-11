<script lang="ts">
  import { App, SAFARI_SURFACE_GUIDANCE } from "@still/core/ui";
  import { createExtensionUiController } from "@still/core/ui";
  import { readAccountStatus } from "../../lib/account-status.js";
import { pushSettingsToApp } from "../../lib/native-settings.js";

  // Push each local edit straight to the App Group (see popup/main.ts — the background reconciler
  // may be asleep on iOS and miss the browser.storage write).
  void browser.runtime.sendMessage({ kind: "reconcile" }).catch(() => {});

  const controller = createExtensionUiController(undefined, {
    accountManagedByApp: true,
    readAccountStatus,
    onLocalSettingsCommit: (record) => void pushSettingsToApp(record),
  });
</script>

<main class="options">
  <App {controller} surfaceGuidance={SAFARI_SURFACE_GUIDANCE} />
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
