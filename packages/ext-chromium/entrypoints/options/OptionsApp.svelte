<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { App } from "@still/core/ui";
  import { createExtensionUiController } from "@still/core/ui";
  import type {
    CommittedPopupBinding,
    CommittedPopupToggle,
  } from "@still/core/ui";
  import { PAID_TIER_ENABLED, SERVICE_IDS, type ServiceId } from "@still/shared-types";
  import {
    PRIVACY_POLICY_URL,
    SUPPORT_EMAIL,
  } from "@still/core/ui/config";
  import { FIRST_RUN_PAGE } from "@still/core/ui/v3/first-run-host";
  import {
    extensionPurchaseDeps,
    restoreHandler,
  } from "../../lib/purchase-wiring.js";
  import { emailConsent } from "../../lib/email-consent.js";
  import { extensionNoticePermissions, extensionNoticeStorage, watchEmailPermissionNotice } from "../../lib/data-permission.js";
  import { surfaceGuidance } from "../../lib/surface-guidance.js";
  import { createPageAnalytics } from "../../lib/analytics.js";
  import { modernSettingsRuntime } from "../../lib/modern-settings-runtime.js";
  import { observeDirectControls } from "@still/core/ui/v3/direct-control-observer";
  import { reportDirectControl } from "../../lib/invitation-client.js";
  import { bindProOptionsNavigation } from "../../lib/pro-navigation.js";
  import { runtimePlatformAnswerFor, type RuntimePlatform } from "../../lib/runtime-platform.js";
  import { settingsFeatures, settingsPhone } from "../../lib/settings-features.js";
  import { browser } from "wxt/browser";

  let optionsRoot: HTMLElement;
  onMount(() => {
    if (
      !(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY) ||
      import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true"
    ) return bindProOptionsNavigation(optionsRoot);
  });

  // An extension page like the popup, so it gets the same purchase-spine injection (plan U6):
  // message-closures over the background-owned session, present only when this build carries
  // Supabase config (the fail-safe env gate).
  const purchase = extensionPurchaseDeps();
  const settingsRuntime = modernSettingsRuntime(
    import.meta.env.VITE_SUPABASE_URL as string | undefined,
    import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
    import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED as string | undefined,
  );
  const analytics = createPageAnalytics(Boolean(import.meta.env.FIREFOX));
  let committedPopupBinding: CommittedPopupBinding | undefined;
  // The browser's answer whenever it comes (`eventual`), not the one-second bound: a desktop
  // Firefox whose answer is late still gets its rows and access once it arrives.
  const platform = runtimePlatformAnswerFor(Boolean(import.meta.env.FIREFOX), browser.runtime).eventual;
  const controller = createExtensionUiController(purchase, {
    emailConsent,
    analytics,
    onCommittedPopupBinding: settingsRuntime.atomicLocal
      ? (binding) => {
          // Direct changes made here count toward the sync invitation (U13-P2). The inline
          // build-time check can only narrow to legacy and keeps configured builds byte-identical.
          committedPopupBinding =
            !(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY) ||
            import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true"
              ? observeDirectControls(binding, reportDirectControl)
              : binding;
        }
      : undefined,
    openedWhere: "options",
    accessHost: import.meta.env.FIREFOX ? "firefox" : "chromium",
    accessPlatform: platform,
  });
  // Firefox: a withdrawn email permission signed the account out of sync; say so (data-permission.ts).
  if (import.meta.env.FIREFOX)
    controller.addTeardown(watchEmailPermissionNotice(controller, extensionNoticeStorage(), extensionNoticePermissions()));
  // This page owns its controller: stop the account poll when the page's view is destroyed.
  onDestroy(() => controller.dispose());
  // Phone surfaces hide the switches that cannot act there (lib/settings-features.ts): drawn as
  // phone rows until Firefox's own answer says desktop, however late. Chromium draws every row.
  let platformAnswer = $state<RuntimePlatform | null>(null);
  void platform.then((answer) => {
    platformAnswer = answer;
  });
  let features = $derived(settingsFeatures(Boolean(import.meta.env.FIREFOX), platformAnswer));
  let phone = $derived(settingsPhone(Boolean(import.meta.env.FIREFOX), platformAnswer));
  const onRestore = purchase ? restoreHandler(controller) : undefined;
  const onCommittedPopupToggle = ({
    service,
    enabled,
  }: CommittedPopupToggle) => {
    if (service === undefined)
      analytics.track("global_toggled", { enabled, where: "options" });
    else
      analytics.track("service_toggled", {
        service,
        enabled,
        where: "options",
      });
  };
  // V3 builds load the settings page through a wrapper that adds the site access warning
  // (ISS-0037): InformationalProSettings in paid-tier builds, otherwise RestoreSettings with its
  // free-period "Restore purchase" link (owner decisions 62 and 73; bound only where the build has
  // the sign-in spine). The inline build-time check (wxt.config's runsV3Interface rule) folds to
  // false on configured 2.x builds, which keep loading ExtensionSettings as before. The paid branch
  // keeps its own inline check: written through this constant, the bundler no longer drops the
  // paid chunk from 2.x builds (checked with the bundle identity snapshots).
  const v3Settings = Boolean(
    !(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY) ||
      import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true",
  );
  const loadSettings =
    (!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY) ||
      import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true") &&
    PAID_TIER_ENABLED && settingsRuntime.atomicLocal
    ? () =>
        import("./InformationalProSettings.svelte").then((module) => {
          // Paid-tier builds only (this branch folds away otherwise): the Still Pro card's Buy,
          // Restore and re-checks over this page's controller and the existing checkout seam.
          module.bindBrowserPro(
            purchase
              ? { controller, checkout: purchase.checkout, analytics, permission: purchase.dataPermission }
              : undefined,
          );
          return module;
        })
    : v3Settings
    ? () =>
        import("./RestoreSettings.svelte").then((module) => {
          module.bindSettingsRestore(purchase ? controller : undefined);
          return module;
        })
    : () => import("@still/core/ui/v3/ExtensionSettings.svelte");
  const help = {
    // Setup guide reopens the extension's own first-run page (owner decision 2026-10-05).
    onGuide: () => {
      window.open(
        chrome.runtime.getURL(FIRST_RUN_PAGE),
        "_blank",
        "noopener,noreferrer",
      );
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

<main class="options" bind:this={optionsRoot}>
  <App
    {controller}
    {onRestore}
    {surfaceGuidance}
    {committedPopupBinding}
    {onCommittedPopupToggle}
    settingsPresentation={committedPopupBinding
      ? {
          browser: import.meta.env.FIREFOX ? "Firefox" : "Chrome",
          loadSettings,
          help,
          sectionMemory,
          features,
          phone,
          // The Still Pro value list waits for Firefox's device answer (ISS-0032).
          platformKnown: !import.meta.env.FIREFOX || platformAnswer !== null,
        }
      : undefined}
  />
</main>

<style>
  .options {
    /* The same cap the app content inside already uses, so this frame is exactly as wide as what
       it holds. A wider frame here would be invisible: App.svelte centres itself at
       --content-max-inline-size regardless, so the settings page's real width is that token and
       this reads it rather than offering a second number that changes nothing. */
    max-inline-size: var(--content-max-inline-size, 432px);
    margin-inline: auto;
    /* The settings column already pads itself by 16px (.app), so this adds at most 16px more: the
       first card sits 32px from the top of a normal-height tab, as on the owner's canvas
       (Chrome-Settings-*, 21 Oct 2026), and closer on a short one. */
    padding-block: clamp(0px, calc(5vh - var(--space-4)), var(--space-4));
    /* Full-width buttons are 44px tall on the Chrome and Firefox Settings page (owner ruling; the
       Apple apps keep 54px): the shared 44px minimum sets the height, with 8px above and below the
       label so a larger text size still grows the button. */
    --block-button-padding: var(--space-2) var(--space-4);
  }
</style>
