import { defineConfig } from "wxt";

// Chromium MV3 build (Chrome/Edge/Brave/Arc). Host permissions are limited to the four service
// domains — never <all_urls> (R14). The static declarativeNetRequest rule is the PRIMARY Shorts
// redirect path on Chromium (network-layer, zero paint — KTD1); the content-script redirect is the
// Safari path. `activeTab` (not `tabs`) powers the popup's pause-on-this-site without broad access.
export default defineConfig({
  modules: ["@wxt-dev/module-svelte"],
  outDir: "dist",
  manifest: {
    name: "Still",
    description: "Removes short-form video — Shorts, Reels, and all of TikTok.",
    permissions: ["storage", "activeTab", "declarativeNetRequestWithHostAccess"],
    host_permissions: [
      "*://*.youtube.com/*",
      "*://*.instagram.com/*",
      "*://*.facebook.com/*",
      "*://*.tiktok.com/*",
    ],
    declarative_net_request: {
      rule_resources: [
        {
          id: "youtube-shorts-redirect",
          enabled: true,
          path: "rules/dnr-youtube.json",
        },
      ],
    },
  },
});
