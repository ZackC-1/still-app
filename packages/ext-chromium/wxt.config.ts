import { readFileSync } from "node:fs";
import { defineConfig } from "wxt";

export const firefoxBrowserSpecificSettings = {
  gecko: {
    id: "still@chartash.com",
    // Firefox's built-in data-collection consent UI only exists on 140+. Since this build declares
    // data collection, pin the minimum so no one can install on an older desktop Firefox and sign
    // in or transmit auth/settings data without that consent screen.
    strict_min_version: "140.0",
    // Optional account sign-in persists a Supabase session ("authenticationInfo": registration info
    // for an account-based extension). Settings sync carries only the signed-in user's own Still
    // preferences under that account.
    // Installing the free blocker never asks for anything else (owner decision, 22 Oct 2026). The
    // rest is optional; Firefox does not show optional types at install and asks the person at run
    // time instead, from their own click (lib/data-permission.ts):
    //   * "personallyIdentifyingInfo": the email address Sign in sends for its code.
    //   * "financialAndPaymentInfo": purchase data, which Still sends only to start a Still Pro
    //     checkout (Get Still Pro). Receiving the account's Still Pro status sends none, so
    //     Restore purchase and Still Pro's re-checks never need it.
    //   * "technicalAndInteraction": usage analytics, which Firefox only allows as optional and
    //     offers in its install prompt; also switched from Still's settings (lib/analytics.ts).
    // Nothing optional is sent until it is granted (lib/firefox-data-guard.ts).
    data_collection_permissions: {
      required: ["authenticationInfo"],
      optional: ["personallyIdentifyingInfo", "financialAndPaymentInfo", "technicalAndInteraction"],
    },
  },
};

// Lists the same add-on for Firefox for Android (AMO offers it on desktop only without this key).
// 142 is the first Android release with the built-in data-collection consent screen, the same
// reason the desktop floor is 140, so nobody on Android can sign in without seeing that consent.
// Mozilla reads data_collection_permissions from `gecko` for both, so it is not repeated here.
export const firefoxAndroidSettings = {
  strict_min_version: "142.0",
};

/** The packaged build inputs this config reads (process.env, which WXT fills from the .env files). */
export type ManifestBuildEnv = Readonly<Record<string, string | undefined>>;

/**
 * Whether this build runs the V3 interface: unconfigured builds, or configured builds that opted
 * into modern sync. The same release rule as lib/modern-settings-runtime.ts `atomicLocal` and
 * entrypoints/tiktok-blocked/gate.ts (lib/__tests__/firefox-manifest.test.ts pins all three).
 * Firefox for Android needs the V3 screens (phone popup, Android first-run) and is deferred to a
 * later update, so store builds are not listed for Android yet; QA sandbox packages are.
 */
export function runsV3Interface(env: ManifestBuildEnv): boolean {
  const configured =
    (env.VITE_SUPABASE_URL ?? "").trim().length > 0 && (env.VITE_SUPABASE_ANON_KEY ?? "").trim().length > 0;
  return !configured || env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true";
}

/**
 * Firefox for Android is deferred from the first V3 release (owner decision, 20 Oct 2026): Chrome,
 * desktop Firefox and the Apple apps ship first, Android follows in a later update once it has been
 * tested there. While this is true, only the never-listed sandbox QA package declares
 * `gecko_android`; a store build does not, so addons.mozilla.org treats the listed version as
 * desktop-only and does not offer it to Firefox for Android users. Every Android code path stays.
 * To ship Android, set this to false (and review the AMO version's Android compatibility).
 *
 * What this does and does not do: AMO decides Android availability from `gecko_android`
 * (https://extensionworkshop.com/documentation/publish/version-compatibility/#android-compatibility).
 * Its absence does NOT stop Firefox for Android itself from installing a signed file, so someone who
 * unlocks Firefox's hidden "Install extension from file" menu can still side-load the add-on.
 * Trade-off: without `gecko_android`, Firefox for Android falls back to the desktop floor in `gecko`
 * (140.0), so a side-loaded store package installs on Firefox for Android 140 and 141, which lack the
 * built-in data-collection consent screen. That screen is why `gecko_android` pins 142.0.
 */
export const FIREFOX_ANDROID_RELEASE_DEFERRED = true;

/** Whether this Firefox build declares `gecko_android`: V3 only, and while deferred, the QA package only. */
export function declaresFirefoxAndroid(env: ManifestBuildEnv): boolean {
  if (!runsV3Interface(env)) return false;
  return qaSandboxPackage(env) || !FIREFOX_ANDROID_RELEASE_DEFERRED;
}

/** `gecko` always; `gecko_android` only where `declaresFirefoxAndroid` allows it. */
export function firefoxSettingsFor(env: ManifestBuildEnv) {
  const settings = qaSandboxPackage(env)
    ? { gecko: { ...firefoxBrowserSpecificSettings.gecko, id: QA_SANDBOX_PACKAGE.firefoxId } }
    : firefoxBrowserSpecificSettings;
  return declaresFirefoxAndroid(env) ? { ...settings, gecko_android: firefoxAndroidSettings } : settings;
}

/**
 * Sandbox QA packages carry their own identity. A separate, never-listed Firefox add-on id means
 * a listed AMO update can never replace an installed QA build (or the reverse), and the QA build
 * is never uploaded through the public listing. Only the paid-sandbox profile in
 * scripts/qa/v3-profile.mjs sets VITE_PACKAGE_IDENTITY; store packaging never forwards it
 * (scripts/release/package.mjs DELIBERATELY_UNPACKAGED).
 */
export const QA_SANDBOX_PACKAGE = {
  firefoxId: "still-qa-sandbox@chartash.com",
  name: "Still QA Sandbox (not for release)",
} as const;

/** Whether this is a sandbox QA package; refuses a QA identity without the sandbox route and trust. */
export function qaSandboxPackage(env: ManifestBuildEnv): boolean {
  const identity = env.VITE_PACKAGE_IDENTITY;
  if (identity === undefined || identity === "") return false;
  if (identity !== "paid-sandbox-qa") throw new Error("VITE_PACKAGE_IDENTITY must be unset or paid-sandbox-qa");
  if (env.VITE_BACKEND_ROUTE_PROFILE !== "shared-hosted-sandbox" || env.VITE_ACCESS_ENVIRONMENT !== "sandbox")
    throw new Error("A sandbox QA package requires the shared-hosted-sandbox route and sandbox access trust");
  return true;
}

/**
 * A sandbox QA package's version: the store version plus a fourth number, main's first-parent
 * commit count, set by the paid-sandbox profile. Mozilla signs each version number only once, so
 * every new QA source gets a new, increasing version. Chrome caps each part at 65535.
 */
export function qaPackageVersion(env: ManifestBuildEnv, storeVersion: string): string {
  const sequence = env.VITE_QA_BUILD_SEQUENCE ?? "";
  if (!/^[1-9]\d{0,4}$/.test(sequence) || Number(sequence) > 65535)
    throw new Error("A sandbox QA package requires VITE_QA_BUILD_SEQUENCE between 1 and 65535");
  if (!/^\d+\.\d+\.\d+$/.test(storeVersion)) throw new Error("The store version must have exactly three parts");
  return `${storeVersion}.${sequence}`;
}

// Read only when a QA package is built: browser-like test environments import this file too.
const storeVersion = (): string =>
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

/** The shipped desktop Firefox summary: every build without `gecko_android` (2.x, and V3 store builds while Android is deferred). */
export const FIREFOX_2X_DESCRIPTION =
  "Remove YouTube Shorts and Instagram & Facebook Reels, and block the TikTok website. Free, with no timers or stats. Sign in free to sync your settings with Chrome and with Safari on iPhone, iPad and Mac. Desktop Firefox.";
/** The V3 Firefox summary, with the owner-approved Firefox on Android wording: builds listed for Android only. */
export const FIREFOX_V3_DESCRIPTION =
  "Remove YouTube Shorts and Instagram & Facebook Reels. Block the TikTok website. Free, no timers. Sign in free to sync your settings with Chrome and with Safari on iPhone, iPad and Mac. Works in Safari on iPhone and iPad, and in Firefox on Android.";

/**
 * The Firefox summary follows the same rule as `gecko_android`: Android is named only where listed.
 * While Firefox for Android is deferred, V3 store builds keep the shipped desktop summary; the V3
 * wording waits for the Android update (owner decision, 20 Oct 2026).
 */
export function firefoxDescriptionFor(env: ManifestBuildEnv): string {
  return declaresFirefoxAndroid(env) ? FIREFOX_V3_DESCRIPTION : FIREFOX_2X_DESCRIPTION;
}

// WebExtension build for Chromium (Chrome/Edge/Brave/Arc) AND Firefox — both MV3, same entrypoints.
// Build Chromium with `wxt build` (→ dist/chrome-mv3) and Firefox with `wxt build -b firefox`
// (→ dist/firefox-mv3). Host permissions are limited to the four service domains — never <all_urls>
// (R14). No tab-access permission: the popup never reads the active tab (the pause-on-this-site
// control and its activeTab grant were removed 2026-07-06).
//
// Shorts→watch redirect:
//   • Chromium: a static declarativeNetRequest rule is the PRIMARY path (network-layer, zero paint —
//     KTD1); the content-script location.replace is the SPA-navigation backstop.
//   • Firefox: does NOT reliably support DNR regexSubstitution redirects (same constraint as Safari),
//     so the Firefox build OMITS DNR and relies solely on the document_start content-script redirect,
//     which is browser-agnostic. The background's DNR wiring no-ops when the API is absent.
export function stillManifest(browser: string, env: ManifestBuildEnv = process.env) {
  const isFirefox = browser === "firefox";
  return {
    // Store-search copy (docs/release/store-listing-copy.md): the stores read the listing's name and
    // summary from here. Firefox's validator caps the name at 45 characters; Chrome caps the
    // description at 132 and AMO's summary at 250 (lib/__tests__/firefox-manifest.test.ts).
    name: qaSandboxPackage(env) ? QA_SANDBOX_PACKAGE.name : "Still: Remove Shorts & Reels, Stop Scrolling",
    ...(qaSandboxPackage(env) ? { version: qaPackageVersion(env, storeVersion()) } : {}),
    description: isFirefox
      ? firefoxDescriptionFor(env)
      : "Remove YouTube Shorts and Instagram & Facebook Reels. Block the TikTok website. Free, no timers. Syncs with Still on iPhone & Mac.",
    permissions: [
      "storage",
      // Sends quietly recorded analytics at a random later time, so arrival never marks a site
      // visit (packages/core/src/analytics/extension-host.ts). Shows no install warning.
      "alarms",
      // DNR is Chromium-only here (see header); Firefox uses the content-script redirect.
      ...(isFirefox ? [] : ["declarativeNetRequestWithHostAccess"]),
    ],
    host_permissions: [
      "*://*.youtube.com/*",
      "*://*.instagram.com/*",
      "*://*.facebook.com/*",
      "*://*.tiktok.com/*",
    ],
    action: {
      default_title: "Still",
      // MDN documents `default_area` as Firefox-only. It gives new desktop installs a discoverable
      // toolbar home; Firefox still lets each user move the action in Customize Toolbar.
      ...(isFirefox ? { default_area: "navbar" } : {}),
    },
    // Firefox requires a stable add-on id; this is PERMANENT once published on AMO.
    ...(isFirefox
      ? {
          // `gecko` for desktop Firefox; `gecko_android` for Firefox for Android (declaresFirefoxAndroid).
          browser_specific_settings: firefoxSettingsFor(env),
        }
      : {
          declarative_net_request: {
            rule_resources: [
              {
                id: "youtube-shorts-redirect",
                enabled: true,
                path: "rules/dnr-youtube.json",
              },
            ],
          },
        }),
  };
}

/**
 * Where Still's Settings page opens (ISS-0097). With `open_in_tab: false`, desktop Firefox shows the
 * options page inside the Add-ons Manager, in a panel it grows to the page's full height. Anything
 * the page positions against its own viewport (the sign-in sheet, the Delete account and Stop
 * sharing confirmations) then lands at the bottom or the middle of that tall panel, often below the
 * fold, while the dimming scrim covers all of it: a grey page with no sheet. So Firefox opens
 * Settings in its own tab; `runtime.openOptionsPage` (the popup's Settings button, first-run's Open
 * Settings, the Still Pro hand-off) reuses an open one, provided its address still matches exactly,
 * which is why lib/pro-navigation.ts leaves the address plain once the hand-off is over. Chrome keeps
 * its embedded dialog, whose viewport is bounded and scrolls. Firefox for Android installs this same
 * manifest (the sandbox QA package while Android is deferred, or a side-loaded store package), so its
 * Settings open as a browser tab there too (otherwise Fenix shows the page inside its own add-on
 * settings screen); the Android emulator lane covers it.
 * WXT writes `options_ui` from the entrypoint after merging `manifest`, so this runs on the
 * generated manifest (the `build:manifestGenerated` hook below).
 */
export function settingsPageHost<M extends { options_ui?: { open_in_tab?: boolean } }>(
  browser: string,
  manifest: M,
): M {
  if (browser === "firefox" && manifest.options_ui) manifest.options_ui.open_in_tab = true;
  return manifest;
}

export default defineConfig({
  modules: ["@wxt-dev/module-svelte"],
  svelte: {
    vite: {
      compilerOptions: {
        // Scope hashes must not depend on the absolute build path. vite-plugin-svelte's default
        // cssHash mixes in the component's normalized filename, and @still/core components resolve
        // through the pnpm symlink to a path OUTSIDE this package's Vite root — so the default hash
        // changes with the checkout directory. AMO reviewers rebuild the sources in their own
        // directory and diff against the uploaded zip; a path-dependent hash guarantees a mismatch.
        // Hashing the css text alone is deterministic everywhere (identical css → identical scoped
        // rules, so collisions are harmless).
        cssHash: ({ hash, css }) => `svelte-${hash(css ?? "")}`,
      },
    },
  },
  outDir: "dist",
  // Force MV3 for every target (WXT defaults Firefox to MV2). Keeps the Firefox manifest shape
  // aligned with the Chromium and Safari (ext-safari) MV3 builds.
  manifestVersion: 3,
  manifest: ({ browser }) => stillManifest(browser),
  hooks: {
    "build:manifestGenerated": (wxt, manifest) => {
      settingsPageHost(wxt.config.browser, manifest);
    },
  },
});
