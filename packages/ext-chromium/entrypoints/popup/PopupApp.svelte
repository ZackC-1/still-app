<script lang="ts">
  import { untrack } from "svelte";
  import { SERVICE_IDS, type ServiceId } from "@still/shared-types";
  import {
    App,
    OpenSettingsButton,
    type SurfaceGuidance,
    type UiController,
    type CommittedPopupBinding,
    type CommittedPopupToggle,
    type LegacyPopupAuthority,
  } from "@still/core/ui";
  import {
    popupPresentationLoader,
    type RuntimePlatform,
  } from "../../lib/runtime-platform.js";

  interface Props {
    controller: UiController;
    browser?: "Chrome" | "Firefox";
    committedPopupBinding?: CommittedPopupBinding;
    legacyPopupAuthority?: LegacyPopupAuthority;
    onCommittedPopupToggle?: (toggle: CommittedPopupToggle) => void;
    /** Web restore = a fresh authenticated reconcile (plan U5/U6). Absent on builds without the
     * purchase spine — the paywall then renders its explanatory state with no live buttons. */
    onRestore?: () => void;
    surfaceGuidance: SurfaceGuidance;
    /** The browser's own platform answer (lib/runtime-platform.ts). Absent means desktop. */
    platform?: Promise<RuntimePlatform>;
  }
  let {
    controller,
    browser = "Chrome",
    committedPopupBinding,
    legacyPopupAuthority,
    onCommittedPopupToggle,
    onRestore,
    surfaceGuidance,
    platform = Promise.resolve("desktop"),
  }: Props = $props();

  // Keep V3 global styles out of shared default/native/options build graphs.
  // The sync invitation wrapper loads only where V3 shows it, and Firefox for Android (V3 builds
  // only, like its listing) gets the phone presentation, chosen by the browser's platform answer and
  // never by width; the build flag keeps that presentation out of the Chromium bundle. The inline
  // build-time check can only narrow to legacy, so configured store-style builds keep the plain
  // loader byte for byte.
  const loadDesktop =
    !(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY) ||
    import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true"
      ? untrack(() =>
          popupPresentationLoader(browser === "Firefox", platform, {
            desktop: () => import("./InvitedDesktopPopup.svelte"),
            firefoxAndroid: import.meta.env.FIREFOX
              ? () => import("./FirefoxAndroidPopup.svelte")
              : () => import("./InvitedDesktopPopup.svelte"),
          }),
        )
      : () => import("../../../core/src/ui/v3/DesktopPopup.svelte");

  function openOptions(): void {
    chrome.runtime.openOptionsPage();
  }
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

<div class="popup">
  <App
    {controller}
    {committedPopupBinding}
    {legacyPopupAuthority}
    {onCommittedPopupToggle}
    {onRestore}
    popupPresentation={committedPopupBinding
      ? { browser, onSettings: openOptions, loadDesktop, sectionMemory }
      : undefined}
    compact
  />
  {#if !committedPopupBinding}<OpenSettingsButton
      {surfaceGuidance}
      onOpen={openOptions}
    />{/if}
</div>

<style>
  .popup {
    /* The width is a hard pixel value from the shared token and must stay one. A browser-action
       popup has no predefined viewport: the browser derives the popup window's width FROM the
       rendered content, so anything relative here is circular. `100vw` resolves to ~0 during that
       measurement pass and the popup renders as a one-character-wide sliver; a plain `100%` is the
       same trap, measured at 69px in a real Chrome toolbar popup.

       max-inline-size is the exception, and it is what lets the same popup fit a phone. It is a
       percentage of the containing block rather than of the viewport, which browsers ignore while
       measuring preferred width, so it does not feed back into the popup's own size. On the desktop
       toolbar it resolves to the full 380px and changes nothing (measured). In Safari on iPhone the
       same document is presented as a sheet at the device width, where 380px is 5px too wide on a
       375pt screen and 60px too wide on a 320pt one, and without this the controls on the right
       edge are cut off with no way to scroll to them.

       (Regression guard: popup-width.test.ts, which forbids relative units on the width and
       requires the clamp on the maximum.) */
    inline-size: var(--popup-inline-size, 380px);
    max-inline-size: 100%;
    margin-inline: auto;
    overflow: clip;
  }
</style>
