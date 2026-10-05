import { mount } from "svelte";
import "@still/core/ui/tokens.css";
import {
  createExtensionUiController,
  type CommittedPopupBinding,
  type CommittedPopupToggle,
  type LegacyPopupAuthority,
} from "@still/core/ui";
import {
  extensionPurchaseDeps,
  restoreHandler,
} from "../../lib/purchase-wiring.js";
import { emailConsent } from "../../lib/email-consent.js";
import { surfaceGuidance } from "../../lib/surface-guidance.js";
import { createPageAnalytics } from "../../lib/analytics.js";
import PopupApp from "./PopupApp.svelte";
import { modernSettingsRuntime } from "../../lib/modern-settings-runtime.js";

// Build the controller — with the purchase-spine injection when this build carries Supabase config
// (plan U6; message-closures over the background-owned session) — then mount the shared UI. No
// per-site pause control: it (and the activeTab grant + tab query that powered it) was removed
// 2026-07-06; only the dormant `pauses` settings field remains in core.
function init(): void {
  const settingsRuntime = modernSettingsRuntime(
    import.meta.env.VITE_SUPABASE_URL as string | undefined,
    import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
    import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED as string | undefined,
  );
  const purchase = extensionPurchaseDeps();
  const analytics = createPageAnalytics(Boolean(import.meta.env.FIREFOX));
  let committedPopupBinding: CommittedPopupBinding | undefined;
  let legacyPopupAuthority: LegacyPopupAuthority | undefined;
  const onCommittedPopupToggle = ({
    service,
    enabled,
  }: CommittedPopupToggle): void => {
    if (service === undefined)
      analytics.track("global_toggled", { enabled, where: "popup" });
    else
      analytics.track("service_toggled", { service, enabled, where: "popup" });
  };
  const controller = createExtensionUiController(purchase, {
    emailConsent,
    analytics,
    onCommittedPopupBinding: settingsRuntime.atomicLocal
      ? (binding) => {
          committedPopupBinding = binding;
        }
      : undefined,
    onLegacyPopupAuthority: !settingsRuntime.atomicLocal
      ? (authority) => {
          legacyPopupAuthority = authority;
        }
      : undefined,
    openedWhere: "popup",
  });
  mount(PopupApp, {
    target: document.getElementById("app")!,
    props: {
      controller,
      browser: import.meta.env.FIREFOX ? "Firefox" : "Chrome",
      committedPopupBinding,
      legacyPopupAuthority,
      onCommittedPopupToggle,
      onRestore: purchase ? restoreHandler(controller) : undefined,
      surfaceGuidance,
    },
  });
}

init();
