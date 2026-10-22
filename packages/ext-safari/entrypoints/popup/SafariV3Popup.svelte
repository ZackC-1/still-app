<script lang="ts">
  import { untrack } from "svelte";
  // Safari V3 popup host: prop plumbing only. DesktopPopup on macOS, MobilePopup on iOS and
  // iPadOS, both over the one committed binding (lib/safari-v3-runtime). Reached only through a
  // dynamic import that default builds fold away, so these components and their global stylesheet
  // exist only in opted-in builds.
  //
  // Get Still Pro, every lock chip and Sign in hand off to the Still app (lib/app-handoff,
  // ISS-0032): Apple purchases happen only in the app's StoreKit flow, and the app owns the account
  // on Safari. appHandoff tells the shared popup so; it offers those actions only where access is
  // conclusively locked (Pro) or nobody is signed in (Sign in). No onPurchase: no price and no
  // checkout link in Safari (App Store Review Guidelines 3.1.1 and 3.1.3).
  //
  // Not offered here, deliberately:
  //  - Sign out, delete account, sync retry: the Apple app owns the account on Safari. The account
  //    display is read-only (appManagedPopupAccount) and the account slot carries only the settings
  //    recovery action.
  //  - Setup and invitations: no verified Safari observation exists for them.
  import DesktopPopup from "@still/core/ui/v3/DesktopPopup.svelte";
  import MobilePopup from "@still/core/ui/v3/MobilePopup.svelte";
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
    safariPopupFillsSheet,
    type SafariPopupSurface,
  } from "../../lib/safari-v3.js";
  import type { SafariAppHandoffResult, SafariAppRoute } from "../../lib/app-handoff.js";

  interface Props {
    /** The one composition (lib/safari-v3-runtime); stopped when this view is destroyed. */
    composition: SafariV3Composition;
    surface: SafariPopupSurface;
    onSettings: () => void;
    /** Opens the Still app at a fixed destination (createSafariAppHandoff for this surface). */
    openApp: (route: SafariAppRoute) => Promise<SafariAppHandoffResult>;
  }
  let { composition, surface, onSettings, openApp }: Props = $props();
  // When Safari refuses the hand-off (e.g. it will not open the still:// link in a tab), say so
  // plainly instead of a tap that does nothing. Cleared by the next attempt.
  let handoffFailed = $state(false);
  async function handOff(route: SafariAppRoute): Promise<void> {
    handoffFailed = false;
    let result: SafariAppHandoffResult;
    try {
      result = await openApp(route);
    } catch {
      result = "failed";
    }
    handoffFailed = result === "failed";
  }
  const onSeePro = () => void handOff("pro");
  const onSignIn = () => void handOff("sync");
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
  // Decided once per opening, from the device screen (see safariPopupFillsSheet).
  const fillsSheet = untrack(() => safariPopupFillsSheet(surface, globalThis.screen?.width));
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

<div class="popup" class:desktop-popup={surface === "desktop"} class:edge-to-edge={fillsSheet}>
  {#if handoffFailed}
    <p class="handoff-failed" role="alert">Open the Still app to continue.</p>
  {/if}
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
      {onSeePro}
      {onSignIn}
      appHandoff
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
      {onSeePro}
      {onSignIn}
      appHandoff
      privacyUrl={PRIVACY_POLICY_URL}
      {account}
      {sectionMemory}
      accountActions={unavailable ? recovery : undefined}
    />
  {:else if unavailable}
    {@render recovery()}
  {:else}
    <p class="muted" role="status">{STRINGS.sync.loading}</p>
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
  .popup.desktop-popup {
    block-size: var(--popup-max-block-size, 600px);
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  .desktop-popup :global(.app[data-density="compact"]) {
    min-block-size: 100%;
    max-block-size: none;
    overflow: visible;
  }
  .desktop-popup :global(.app[data-density="compact"] .site-scroll) {
    flex: none;
    max-block-size: none;
    overflow: visible;
  }
  /* The iPhone and iPad popup grows to fit an open site, as the Mac popup does (owner canvas,
     Safari-Popup-Locked and -ProOpen; ISS-0098 option B): the site list is never a scroll box of
     its own (MobilePopup caps it at 312px and the page at 600px), and past the sheet's height the
     page itself scrolls. Nothing here takes a size from the viewport, so the popover's own
     content-sizing pass (iPad) cannot feed back into it. */
  .popup:not(.desktop-popup) :global(.app[data-density="compact"]) {
    max-block-size: none;
  }
  .popup:not(.desktop-popup) :global(.app[data-density="compact"] .site-scroll) {
    flex: none;
    max-block-size: none;
    overflow-x: visible;
    overflow-y: visible;
  }
  /* "Open the Still app to continue." (owner canvas, MacPopup-Offline): a raised 12px-radius note
     inside the popup's 12px inset, 8px above the hero. */
  .handoff-failed {
    margin: var(--space-3, 12px) var(--space-3, 12px) 0;
    padding: var(--space-2, 8px) var(--space-3, 12px);
    border-radius: 12px;
    background: var(--surface-raised);
    font-size: calc(13px * var(--text-scale, 1));
    line-height: 1.4;
    color: var(--ink, inherit);
  }
  .handoff-failed + :global(.app) {
    padding-block-start: var(--space-2, 8px);
  }
  .popup.edge-to-edge {
    /* The iPhone sheet only: fill the width Safari gives the sheet, edge to edge as designed. A
       percentage minimum, never a viewport unit: during any measuring pass it resolves to 0 and the
       pixel width above still holds, so it can never collapse the popup. */
    min-inline-size: 100%;
  }
</style>
