import { defineConfig } from "wxt";

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
      name: "Still",
      description: "Removes short-form video — Shorts, Reels, and all of TikTok.",
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
            browser_specific_settings: {
              gecko: {
                id: "still@chartash.com",
                // Firefox's built-in data-collection consent UI only exists on 140+. Since this
                // build declares data collection (below), pin the minimum to 140 so no one can
                // install on an older Firefox and sign in / transmit auth+settings data WITHOUT a
                // consent screen — the exact case Mozilla's built-in-consent docs require handling
                // (min version / disable collection / custom consent), and an AMO-rejection risk
                // otherwise.
                strict_min_version: "140.0",
                // Mandatory AMO data-collection consent (H1 2026, R11). The purchase spine (plan
                // U5/U6) signs users in with an emailed one-time code and keeps a Supabase session
                // in extension storage, so the former ["none"] is no longer true: declare
                // authentication data. Settings sync transmits only the signed-in user's own Still
                // settings under that same account — no separate AMO category covers app
                // preferences today. Re-verify category names against AMO's current list at
                // submission time (plan risk note).
                data_collection_permissions: { required: ["authenticationInfo"] },
              },
              // Without gecko_android the add-on is desktop-only on AMO — but the release gate
              // (docs/release/06-mobile-blocking-validation.md) requires validating on Firefox for
              // Android, and m.youtube.com Shorts removal ships specifically for mobile. Same 140
              // floor as desktop: the consent UI requirement applies there too.
              gecko_android: { strict_min_version: "140.0" },
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
