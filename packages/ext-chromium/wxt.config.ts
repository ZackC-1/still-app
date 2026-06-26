import { defineConfig } from "wxt";

// WebExtension build for Chromium (Chrome/Edge/Brave/Arc) AND Firefox — both MV3, same entrypoints.
// Build Chromium with `wxt build` (→ dist/chrome-mv3) and Firefox with `wxt build -b firefox`
// (→ dist/firefox-mv3). Host permissions are limited to the four service domains — never <all_urls>
// (R14). `activeTab` (not `tabs`) powers the popup's pause-on-this-site without broad access.
//
// Shorts→watch redirect:
//   • Chromium: a static declarativeNetRequest rule is the PRIMARY path (network-layer, zero paint —
//     KTD1); the content-script location.replace is the SPA-navigation backstop.
//   • Firefox: does NOT reliably support DNR regexSubstitution redirects (same constraint as Safari),
//     so the Firefox build OMITS DNR and relies solely on the document_start content-script redirect,
//     which is browser-agnostic. The background's DNR wiring no-ops when the API is absent.
export default defineConfig({
  modules: ["@wxt-dev/module-svelte"],
  outDir: "dist",
  // Force MV3 for every target (WXT defaults Firefox to MV2). Keeps the Firefox manifest shape
  // aligned with the Chromium and Safari (ext-safari) MV3 builds.
  manifestVersion: 3,
  manifest: ({ browser }) => {
    const isFirefox = browser === "firefox";
    return {
      name: "Still",
      description: "Removes short-form video — Shorts, Reels, and all of TikTok.",
      permissions: [
        "storage",
        "activeTab",
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
            browser_specific_settings: {
              gecko: {
                id: "still@chartash.com",
                // Becoming mandatory for new AMO submissions (Firefox data-consent): Still's extension
                // collects and transmits no personal data, so declare "none". Backward-compatible
                // (ignored on older Firefox), so we don't pin strict_min_version and shrink reach.
                // Revisit if Pro cloud-sync wiring (U10) ever transmits user data from the extension.
                data_collection_permissions: { required: ["none"] },
              },
            },
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
