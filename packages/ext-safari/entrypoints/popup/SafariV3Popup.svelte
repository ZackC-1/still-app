<script lang="ts">
  import { untrack } from "svelte";
  // Safari V3 popup host: prop plumbing only. DesktopPopup on macOS, MobilePopup on iOS and
  // iPadOS, both over the one committed binding (lib/safari-v3-runtime). Reached only through a
  // dynamic import that default builds fold away, so these components and their global stylesheet
  // exist only in opted-in builds.
  //
  // Not offered here, deliberately:
  //  - "Open Still" / "See Still Pro": no onSeePro. Nothing renders it while the paid tier is off,
  //    and the route to the app's Access & purchases section is a separate Apple app-link unit that
  //    must land before paid launch (owner decision 14).
  //  - Sign in, sign out, delete account, sync retry: the Apple app owns the account on Safari.
  //    The account display is read-only (appManagedPopupAccount) and the account slot carries only
  //    the settings recovery action.
  //  - Setup and invitations: no verified Safari observation exists for them.
  import DesktopPopup from "../../../core/src/ui/v3/DesktopPopup.svelte";
  import MobilePopup from "../../../core/src/ui/v3/MobilePopup.svelte";
  import {
    PRIVACY_POLICY_URL,
    STRINGS,
    createPopupViewBinding,
  } from "@still/core/ui";
  import { SERVICE_IDS, type ServiceId } from "@still/shared-types";
  import type { SafariV3Composition } from "../../lib/safari-v3-runtime.js";
  import {
    SAFARI_DESKTOP_POPUP_BROWSER,
    SAFARI_SETTINGS_LABEL,
    appManagedPopupAccount,
    type SafariPopupSurface,
  } from "../../lib/safari-v3.js";

  interface Props {
    /** The one composition (lib/safari-v3-runtime); stopped when this view is destroyed. */
    composition: SafariV3Composition;
    surface: SafariPopupSurface;
    onSettings: () => void;
  }
  let { composition, surface, onSettings }: Props = $props();
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
  let account = $derived(appManagedPopupAccount(c, STRINGS.sync));
  let ready = $derived(
    view.settings && view.state && view.commands
      ? {
          settings: view.settings,
          access: view.state.access,
          commands: view.commands,
        }
      : null,
  );
  // Presentation-only: this origin-local choice never enters the blocking document or sync.
  const sectionMemory = {
    read(): ServiceId | null {
      try {
        const saved = localStorage.getItem("still-popup-open");
        return SERVICE_IDS.find((service) => service === saved) ?? null;
      } catch {
        return null;
      }
    },
    write(service: ServiceId | null): void {
      try {
        if (service) localStorage.setItem("still-popup-open", service);
        else localStorage.removeItem("still-popup-open");
      } catch {
        /* Local presentation memory must never interrupt a settings command. */
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

<div class="popup">
  {#if ready && surface === "desktop"}
    <DesktopPopup
      settings={ready.settings}
      access={ready.access}
      browser={SAFARI_DESKTOP_POPUP_BROWSER}
      settingsLabel={SAFARI_SETTINGS_LABEL}
      commandsDisabled={view.held}
      onGlobalChange={ready.commands.global}
      onServiceChange={ready.commands.service}
      onFeatureChange={ready.commands.feature}
      {onSettings}
      privacyUrl={PRIVACY_POLICY_URL}
      {account}
      {sectionMemory}
      accountActions={unavailable ? recovery : undefined}
    />
  {:else if ready}
    <MobilePopup
      host="safari"
      settings={ready.settings}
      access={ready.access}
      commandsDisabled={view.held}
      onGlobalChange={ready.commands.global}
      onServiceChange={ready.commands.service}
      onFeatureChange={ready.commands.feature}
      {onSettings}
      privacyUrl={PRIVACY_POLICY_URL}
      {account}
      {sectionMemory}
      accountActions={unavailable ? recovery : undefined}
    />
  {:else if unavailable}
    {@render recovery()}
  {:else}
    <p class="muted" role="status">{STRINGS.sync.checking}</p>
  {/if}
</div>

<style>
  .popup {
    /* Same rule, for the same reasons, as PopupApp.svelte (see the comment there): a hard pixel
       width from the shared token, clamped to the surface so the iPhone sheet never cuts off the
       right-hand switches. Guarded by popup-width.test.ts. */
    inline-size: var(--popup-inline-size, 380px);
    max-inline-size: 100%;
    margin-inline: auto;
    overflow: clip;
  }
</style>
