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
                // Mandatory AMO data-collection consent (H1 2026, R11). The purchase spine (plan
                // U5/U6) signs users in with an emailed one-time code and keeps a Supabase session
                // in extension storage, so the former ["none"] is no longer true: declare
                // authentication data. Settings sync transmits only the signed-in user's own Still
                // settings under that same account — no separate AMO category covers app
                // preferences today. Backward-compatible (ignored on older Firefox), so we still
                // don't pin strict_min_version. Re-verify category names against AMO's current
                // list at submission time (plan risk note).
                data_collection_permissions: { required: ["authenticationInfo"] },
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
