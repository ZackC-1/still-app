<script lang="ts">
  import { untrack } from "svelte";
  // Safari V3 settings page host: prop plumbing only, over the one committed binding
  // (lib/safari-v3-runtime). Reached only through a dynamic import that default builds fold away.
  //
  // The Apple app owns the account on Safari, so the sync card gets a read-only account
  // (appManagedSettingsSync): no sign-in, sign-out, delete-account or retry callback exists here,
  // and the card hides every action whose callback is absent. No Still Pro, Restore, account-link
  // or sharing card is supplied: no price, purchase or paywall on this surface.
  import ExtensionSettings from "@still/core/ui/v3/ExtensionSettings.svelte";
  import {
    PRIVACY_POLICY_URL,
    SETUP_GUIDE_URL,
    SUPPORT_EMAIL,
  } from "@still/core/ui/config";
  import {
    STRINGS,
    createPopupViewBinding,
  } from "@still/core/ui";
  import { SERVICE_IDS, type FeatureId, type ServiceId } from "@still/shared-types";
  import { appManagedSettingsSync } from "../../lib/safari-v3.js";
  import type { SafariV3Composition } from "../../lib/safari-v3-runtime.js";

  interface Props {
    /** The one composition (lib/safari-v3-runtime); stopped when this view is destroyed. */
    composition: SafariV3Composition;
    /** The rows to draw (iPhone/iPad omit the desktop-layout-only extras); omitted draws all. */
    features?: readonly FeatureId[];
  }
  let { composition, features }: Props = $props();
  // One composition per mount; it never changes for this view's lifetime.
  const {
    controller: c,
    binding,
    report: onCommittedToggle,
  } = untrack(() => composition);

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
  $effect(() => () => composition.stop());
  // Until the first settings read settles, a hold is "checking", not "unavailable".
  let reading = $state(true);
  $effect(() => {
    let live = true;
    void composition.settled.then(() => {
      if (live) reading = false;
    });
    return () => {
      live = false;
    };
  });
  let unavailable = $derived(!reading && view.settingsUnavailable);
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
  {#if unavailable}
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
      {features}
      sync={{
        ...sync,
        accountActions: unavailable ? recovery : undefined,
      }}
      {help}
    />
  {:else if unavailable}
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
