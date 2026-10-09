import { readFileSync } from "node:fs";
import { defineConfig } from "wxt";

export const firefoxBrowserSpecificSettings = {
  gecko: {
    id: "still@chartash.com",
    // Firefox's built-in data-collection consent UI only exists on 140+. Since this build declares
    // data collection, pin the minimum so no one can install on an older desktop Firefox and sign
    // in or transmit auth/settings data without that consent screen.
    strict_min_version: "140.0",
    // Optional account sign-in uses an emailed one-time code and persists a Supabase session. Settings
    // sync carries only the signed-in user's own Still preferences under that account.
    // Usage analytics is "technicalAndInteraction", which Firefox only allows as optional: the
    // person can switch it on at install, or later from Still's settings (lib/analytics.ts), and
    // nothing is sent until they do.
    data_collection_permissions: {
      required: ["authenticationInfo"],
      optional: ["technicalAndInteraction"],
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
 * Firefox for Android ships only with V3 (its phone popup and Android first-run are V3 screens),
 * so a configured 2.x store build is never listed for Android.
 */
export function runsV3Interface(env: ManifestBuildEnv): boolean {
  const configured =
    (env.VITE_SUPABASE_URL ?? "").trim().length > 0 && (env.VITE_SUPABASE_ANON_KEY ?? "").trim().length > 0;
  return !configured || env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true";
}

/** `gecko` always; `gecko_android` only for a V3 build. */
export function firefoxSettingsFor(env: ManifestBuildEnv) {
  const settings = qaSandboxPackage(env)
    ? { gecko: { ...firefoxBrowserSpecificSettings.gecko, id: QA_SANDBOX_PACKAGE.firefoxId } }
    : firefoxBrowserSpecificSettings;
  return runsV3Interface(env) ? { ...settings, gecko_android: firefoxAndroidSettings } : settings;
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

const STORE_VERSION: string = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

/** The 2.x Firefox summary, unchanged: a 2.x build has no `gecko_android`, so it stays desktop. */
export const FIREFOX_2X_DESCRIPTION =
  "Remove YouTube Shorts and Instagram & Facebook Reels, and block the TikTok website. Free, with no timers or stats. Sign in free to sync your settings with Chrome and with Safari on iPhone, iPad and Mac. Desktop Firefox.";
/** The V3 Firefox summary, with the owner-approved Firefox on Android wording. */
export const FIREFOX_V3_DESCRIPTION =
  "Remove YouTube Shorts and Instagram & Facebook Reels. Block the TikTok website. Free, no timers. Sign in free to sync your settings with Chrome and with Safari on iPhone, iPad and Mac. Works in Safari on iPhone and iPad, and in Firefox on Android.";

/** The Firefox summary follows the same rule as `gecko_android`: Android is named only where listed. */
export function firefoxDescriptionFor(env: ManifestBuildEnv): string {
  return runsV3Interface(env) ? FIREFOX_V3_DESCRIPTION : FIREFOX_2X_DESCRIPTION;
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
    ...(qaSandboxPackage(env) ? { version: qaPackageVersion(env, STORE_VERSION) } : {}),
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
          // `gecko` for desktop Firefox; `gecko_android` for Firefox for Android on V3 builds only.
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
});
