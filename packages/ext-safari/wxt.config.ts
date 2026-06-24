import { defineConfig } from "wxt";

// Safari Web Extension build. WXT defaults Safari to MV2; we force MV3 (KTD3) so the manifest
// shape matches Chromium. The produced web resources are referenced (not copied) by the Xcode
// project in U17 via `xcrun safari-web-extension-packager`. Building these resources does NOT
// require macOS/Xcode — only the native packaging step does (Phase B).
//
// Safari does not reliably support declarativeNetRequest regexSubstitution redirects, so the
// Shorts redirect uses a document_start content-script location.replace here (KTD1), not DNR.
export default defineConfig({
  modules: ["@wxt-dev/module-svelte"],
  manifestVersion: 3,
  outDir: "dist",
  manifest: {
    name: "Still",
    description: "Removes short-form video — Shorts, Reels, and all of TikTok.",
    permissions: ["storage"],
    host_permissions: [
      "*://*.youtube.com/*",
      "*://*.instagram.com/*",
      "*://*.facebook.com/*",
      "*://*.tiktok.com/*",
    ],
  },
});
