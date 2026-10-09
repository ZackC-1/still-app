<script lang="ts">
  import { onMount } from "svelte";
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
  import { surfaceGuidance } from "../../lib/surface-guidance.js";
  import { createPageAnalytics } from "../../lib/analytics.js";
  import { modernSettingsRuntime } from "../../lib/modern-settings-runtime.js";
  import { observeDirectControls } from "@still/core/ui/v3/direct-control-observer";
  import { reportDirectControl } from "../../lib/invitation-client.js";
  import { bindProOptionsNavigation } from "../../lib/pro-navigation.js";
  import { runtimePlatformFor, type RuntimePlatform } from "../../lib/runtime-platform.js";
  import { settingsFeatures } from "../../lib/settings-features.js";
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
  const platform = runtimePlatformFor(Boolean(import.meta.env.FIREFOX), browser.runtime);
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
  // Phone surfaces hide the switches that cannot act there (lib/settings-features.ts): drawn as
  // phone rows until Firefox's own answer says desktop. Chromium always draws every row.
  let platformAnswer = $state<RuntimePlatform | null>(null);
  void platform.then((answer) => {
    platformAnswer = answer;
  });
  let features = $derived(settingsFeatures(Boolean(import.meta.env.FIREFOX), platformAnswer));
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
  // Free-period "Restore purchase" (owner decisions 62 and 73): V3 new-sync builds only. The
  // inline build-time check folds to false on configured 2.x and unconfigured builds, which keep
  // loading ExtensionSettings exactly as before; the Restore wrapper and its check live only in the
  // lazily loaded wrapper chunk, which this page binds to its controller when it loads it.
  const freeRestore = Boolean(
    import.meta.env.VITE_SUPABASE_URL &&
      import.meta.env.VITE_SUPABASE_ANON_KEY &&
      import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true",
  );
  const loadSettings =
    (!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY) ||
      import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true") &&
    PAID_TIER_ENABLED && settingsRuntime.atomicLocal
    ? () => import("./InformationalProSettings.svelte")
    : freeRestore
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
    padding-block: clamp(var(--space-3), 5vh, var(--space-8));
  }
</style>
