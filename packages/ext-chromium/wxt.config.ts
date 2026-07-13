import { defineConfig } from "wxt";

export const firefoxBrowserSpecificSettings = {
  gecko: {
    id: "still@chartash.com",
    // Firefox's built-in data-collection consent UI only exists on 140+. Since this build declares
    // data collection, pin the minimum so no one can install on an older desktop Firefox and sign
    // in or transmit auth/settings data without that consent screen.
    strict_min_version: "140.0",
    // Optional Pro sign-in uses an emailed one-time code and persists a Supabase session. Settings
    // sync carries only the signed-in user's own Still preferences under that account.
    data_collection_permissions: { required: ["authenticationInfo"] },
  },
};

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
  manifest: ({ browser }) => {
    const isFirefox = browser === "firefox";
    return {
      name: "Still: Block Shorts & Reels",
      description:
        "Block YouTube Shorts free. Still Pro removes Reels and TikTok and syncs settings across supported browsers.",
      permissions: [
        "storage",
        // DNR is Chromium-only here (see header); Firefox uses the content-script redirect.
        ...(isFirefox ? [] : ["declarativeNetRequestWithHostAccess"]),
      ],
      host_permissions: [
        "*://*.youtube.com/*",
        "*://*.instagram.com/*",
        "*://*.facebook.com/*",
        "*://*.tiktok.com/*",
      ],
      // Firefox requires a stable add-on id; this is PERMANENT once published on AMO.
      ...(isFirefox
        ? {
            // Deliberately omit gecko_android for launch. AMO therefore lists this build for desktop
            // Firefox only, matching the product promise that mobile support is Safari-only.
            browser_specific_settings: firefoxBrowserSpecificSettings,
          }
        : {
            declarative_net_request: {
              rule_resources: [
                { id: "youtube-shorts-redirect", enabled: true, path: "rules/dnr-youtube.json" },
              ],
            },
          }),
    };
  },
});
