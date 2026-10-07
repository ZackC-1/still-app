<script module lang="ts">
  import {
    settingsRestoreHost,
    type SettingsRestoreHost,
  } from "../../lib/settings-restore.js";

  let bound: SettingsRestoreHost | undefined;

  /**
   * Called by the options page each time it loads this wrapper (V3 new-sync builds only), with its
   * controller when the build has the sign-in spine and undefined otherwise. Unbound, the wrapper
   * renders the settings page with no Restore link.
   */
  export function bindSettingsRestore(
    controller: SettingsRestoreHost["controller"] | undefined,
  ): void {
    bound = controller ? settingsRestoreHost(controller) : undefined;
  }
</script>

<script lang="ts">
  import ExtensionSettings from "@still/core/ui/v3/ExtensionSettings.svelte";
  import type {
    ExtensionSettingsProps,
    RestoreStatusCardProps,
  } from "@still/core/ui/v3/extension-settings-presentation";
  import { createBrowserSettingsRestore } from "@still/core/ui/v3/browser-settings-restore";

  // The V3 new-sync settings page with its free-period "Restore purchase" link (owner decisions
  // 62 and 73). Loaded in place of ExtensionSettings only by those builds; every other prop passes
  // through unchanged. The props are named one by one rather than spread: a rest/spread would add
  // a Svelte runtime helper to the chunk every build shares, changing configured 2.x bundles. The
  // wrapper test fails if ExtensionSettingsProps gains a prop this list does not forward.
  let {
    settings,
    access,
    onGlobalChange,
    onServiceChange,
    onFeatureChange,
    sectionMemory,
    services,
    features,
    labels,
    commandsDisabled,
    sync,
    pro,
    restore,
    link,
    sharing,
    privacyActions,
    setup,
    help,
  }: Omit<ExtensionSettingsProps, "onRestore"> = $props();
  const host = bound;
  let card = $state.raw<RestoreStatusCardProps | undefined>(undefined);
  const flow = host
    ? createBrowserSettingsRestore({
        check: host.check,
        openSignIn: () => host.controller.openSignIn(),
        publish: (next) => {
          card = next;
        },
      })
    : undefined;
  $effect(() => {
    const userId = host?.controller.userId ?? null;
    const signInOpen = host?.controller.signInOpen ?? false;
    flow?.observe({ userId, signInOpen });
  });
  $effect(() => () => flow?.stop());
  // Signed out, the link needs the normal sign-in; without one there is nothing to check.
  let onRestore = $derived(
    flow && host && (host.controller.userId || host.controller.canSignIn)
      ? () => flow.request()
      : undefined,
  );
</script>

<ExtensionSettings
  {settings}
  {access}
  {onGlobalChange}
  {onServiceChange}
  {onFeatureChange}
  {sectionMemory}
  {services}
  {features}
  {labels}
  {commandsDisabled}
  {sync}
  {pro}
  restore={card ?? restore}
  {onRestore}
  {link}
  {sharing}
  {privacyActions}
  {setup}
  {help}
/>
