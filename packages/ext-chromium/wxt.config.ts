import { defineConfig } from "wxt";

// Chromium MV3 build (Chrome/Edge/Brave/Arc). Host permissions are limited to the four
// service domains — never <all_urls> (R14). The static DNR redirect rule (KTD1) is wired
// in U10; this scaffold establishes the package and manifest baseline.
export default defineConfig({
  modules: ["@wxt-dev/module-svelte"],
  outDir: "dist",
  manifest: {
    name: "Still",
    description: "Removes short-form video — Shorts, Reels, and all of TikTok.",
    permissions: ["storage", "declarativeNetRequestWithHostAccess"],
    host_permissions: [
      "*://*.youtube.com/*",
      "*://*.instagram.com/*",
      "*://*.facebook.com/*",
      "*://*.tiktok.com/*",
    ],
  },
});
