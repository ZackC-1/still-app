<script lang="ts">
  // Safari V3 settings page host: prop plumbing only, over the one committed binding
  // (lib/safari-v3-runtime). Reached only through a dynamic import that default builds fold away.
  //
  // The Apple app owns the account on Safari, so the sync card gets a read-only account
  // (appManagedSettingsSync): no sign-in, sign-out, delete-account or retry callback exists here,
  // and the card hides every action whose callback is absent. No Still Pro, Restore, account-link
  // or sharing card is supplied: no price, purchase or paywall on this surface.
  import ExtensionSettings from "../../../core/src/ui/v3/ExtensionSettings.svelte";
  import {
    PRIVACY_POLICY_URL,
    SETUP_GUIDE_URL,
    SUPPORT_EMAIL,
  } from "../../../core/src/ui/config.js";
  import {
    STRINGS,
    createPopupViewBinding,
    type CommittedPopupBinding,
    type CommittedPopupToggle,
    type UiController,
  } from "@still/core/ui";
  import { SERVICE_IDS, type ServiceId } from "@still/shared-types";
  import { appManagedSettingsSync } from "../../lib/safari-v3.js";

  interface Props {
    controller: UiController;
    binding: CommittedPopupBinding;
    onCommittedToggle?: (toggle: CommittedPopupToggle) => void;
  }
  let { controller: c, binding, onCommittedToggle }: Props = $props();

  const view = createPopupViewBinding(
    () => binding,
    (toggle) => {
      try {
        onCommittedToggle?.(toggle);
      } catch {
        /* Telemetry never changes the saved outcome. */
      }
    },
  );
  let sync = $derived(appManagedSettingsSync(c, STRINGS.sync));
  let ready = $derived(
    view.settings && view.state && view.commands
      ? {
          settings: view.settings,
          access: view.state.access,
          commands: view.commands,
        }
      : null,
  );
  // Setup guide: the live website guide, as for the Apple app's settings (owner decision 11).
  const help = {
    onGuide: () => {
      window.open(SETUP_GUIDE_URL, "_blank", "noopener,noreferrer");
    },
    onSupport: () => {
      window.location.href = `mailto:${SUPPORT_EMAIL}`;
    },
    onPrivacy: () => {
      window.open(PRIVACY_POLICY_URL, "_blank", "noopener,noreferrer");
    },
  };
  const sectionMemory = {
    read(): ServiceId | null {
      try {
        const saved = localStorage.getItem("still-options-open");
        return SERVICE_IDS.find((service) => service === saved) ?? null;
      } catch {
        return null;
      }
    },
    write(service: ServiceId | null): void {
      try {
        if (service) localStorage.setItem("still-options-open", service);
        else localStorage.removeItem("still-options-open");
      } catch {
        /* Local presentation memory cannot interrupt a deliberate command. */
      }
    },
  };
</script>

{#snippet recovery()}
  {#if view.settingsUnavailable}
    <p class="muted" role="status">Settings are unavailable.</p>
    <button
      type="button"
      class="secondary block"
      disabled={view.recovering}
      onclick={view.recoverSettings}>Try again</button
    >
  {/if}
{/snippet}

<main class="options">
  {#if ready}
    <ExtensionSettings
      settings={ready.settings}
      access={ready.access}
      commandsDisabled={view.held}
      onGlobalChange={ready.commands.global}
      onServiceChange={ready.commands.service}
      onFeatureChange={ready.commands.feature}
      {sectionMemory}
      sync={{
        ...sync,
        accountActions: view.settingsUnavailable ? recovery : undefined,
      }}
      {help}
    />
  {:else if view.settingsUnavailable}
    {@render recovery()}
  {:else}
    <p class="muted" role="status">{STRINGS.sync.checking}</p>
  {/if}
</main>

<style>
  .options {
    /* Same frame as OptionsApp.svelte: the shared content width token. */
    max-inline-size: var(--content-max-inline-size, 432px);
    margin-inline: auto;
    padding-block: clamp(var(--space-3), 5vh, var(--space-8));
  }
</style>
