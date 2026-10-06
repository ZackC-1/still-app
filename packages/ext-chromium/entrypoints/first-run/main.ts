import { mount } from "svelte";
import { browser } from "wxt/browser";
import "@still/core/ui/tokens.css";
import {
  createExtensionUiController,
  PRIVACY_POLICY_URL,
  type CommittedPopupBinding,
  type LegacyPopupAuthority,
} from "@still/core/ui";
import { extensionPurchaseDeps } from "../../lib/purchase-wiring.js";
import { emailConsent } from "../../lib/email-consent.js";
import { createPageAnalytics } from "../../lib/analytics.js";
import { modernSettingsRuntime } from "../../lib/modern-settings-runtime.js";
import { declaredSiteOrigins, firstRunAnalytics, type PinApi } from "./first-run-ports.js";
import FirstRunApp from "./FirstRunApp.svelte";
import { isFirefoxAndroid, runtimePlatformFor, type RuntimePlatform } from "../../lib/runtime-platform.js";

// The D14 first-run page. The background opens it once, on a brand-new install; Settings → Setup
// guide reopens it. It is a thin host over the same pieces the popup and settings page use: the
// shared UI controller (existing optional sign-in, existing usage-sharing switch) and the committed
// settings view. It adds no events: the analytics closed schema has no "first-run" surface, so this
// page records nothing and keeps only the usage-sharing switch and account attribution that the
// existing sign-in and switch already carry.

function init(isFirefox: boolean, platform: RuntimePlatform): void {
  const settingsRuntime = modernSettingsRuntime(
    import.meta.env.VITE_SUPABASE_URL as string | undefined,
    import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
    import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED as string | undefined,
  );
  let binding: CommittedPopupBinding | undefined;
  let legacy: LegacyPopupAuthority | undefined;
  const controller = createExtensionUiController(extensionPurchaseDeps(), {
    emailConsent,
    analytics: firstRunAnalytics(createPageAnalytics(isFirefox)),
    onCommittedPopupBinding: settingsRuntime.atomicLocal
      ? (committed) => {
          binding = committed;
        }
      : undefined,
    onLegacyPopupAuthority: !settingsRuntime.atomicLocal
      ? (authority) => {
          legacy = authority;
        }
      : undefined,
    // The build constant, not `isFirefox`: each build then names only its own host (the built
    // bundle is checked by tests/playwright/extras-host-build.spec.ts).
    accessHost: import.meta.env.FIREFOX ? "firefox" : "chromium",
  });
  mount(FirstRunApp, {
    target: document.getElementById("app")!,
    props: {
      controller,
      browser: isFirefox ? "firefox" : "chrome",
      binding,
      legacy,
      permissions: chrome.permissions,
      origins: declaredSiteOrigins(chrome.runtime.getManifest()),
      action: isFirefox ? undefined : (chrome.action as unknown as PinApi),
      // Firefox for Android has no toolbar to pin Still to, so that step is left out there.
      toolbar: !isFirefoxAndroid(isFirefox, platform),
      onOpenSettings: () => void chrome.runtime.openOptionsPage(),
      onOpenPrivacy: () => {
        window.open(PRIVACY_POLICY_URL, "_blank", "noopener,noreferrer");
      },
    },
  });
}

// The platform comes from the browser's own answer, never the window size, and is known before the
// page renders so the steps never change under the reader. The Chromium build never asks.
{
  const isFirefox = Boolean(import.meta.env.FIREFOX);
  void runtimePlatformFor(isFirefox, browser.runtime).then((platform) => init(isFirefox, platform));
}
