import { defineConfig } from "wxt";

// Safari Web Extension build. WXT defaults Safari to MV2; we force MV3 (KTD3) so the manifest
// shape matches Chromium. The produced web resources are referenced (not copied) by the Xcode
// project in U17 via `xcrun safari-web-extension-packager`. Building these resources does NOT
// require macOS/Xcode — only the native packaging step does (Phase B).
//
// Safari does not reliably support declarativeNetRequest regexSubstitution redirects, so the
// Shorts redirect uses a document_start content-script location.replace here (KTD1), not DNR.
export default defineConfig({
  hooks: {
    "entrypoints:found": (_wxt, infos) => {
      // WXT loads mode/browser-specific environment files before discovering entrypoints.
      const env = process.env;
      const configured = !!env.VITE_SUPABASE_URL && !!env.VITE_SUPABASE_ANON_KEY;
      const modern = (env.VITE_APPLE_ATOMIC_SETTINGS === "true" && !configured) ||
        (env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true" && configured);
      if (modern) return;
      const index = infos.findIndex((entry) => entry.name === "tiktok-blocked");
      if (index >= 0) infos.splice(index, 1);
    },
  },
  modules: ["@wxt-dev/module-svelte"],
  svelte: {
    vite: {
      compilerOptions: {
        // Scope hashes must not depend on the absolute build path. Copied from
        // packages/ext-chromium/wxt.config.ts (keep the three in sync). vite-plugin-svelte's default
        // cssHash mixes in the component's normalized filename, and @still/core components resolve
        // through the pnpm symlink to a path OUTSIDE this package's Vite root, so the default hash
        // changes with the checkout directory. Hashing the css text alone is deterministic everywhere
        // (identical css gives identical scoped rules, so collisions are harmless).
        cssHash: ({ hash, css }) => `svelte-${hash(css ?? "")}`,
      },
    },
  },
  manifestVersion: 3,
  outDir: "dist",
  manifest: {
    name: "Still",
    description: "Removes short-form video — Shorts, Reels, and all of TikTok.",
    // `nativeMessaging` lets the background bridge talk to the app's SafariWebExtensionHandler /
    // App-Group container (KTD4). No tab-access permission: the pause-on-this-site control (and
    // its activeTab grant) was removed 2026-07-06.
    // "alarms" sends quietly recorded analytics at a random later time, so arrival never marks a
    // site visit (packages/core/src/analytics/extension-host.ts).
    permissions: ["storage", "nativeMessaging", "alarms"],
    action: {
      default_title: "Still",
      default_icon: {
        16: "icon/16.png",
        32: "icon/32.png",
        48: "icon/48.png",
        96: "icon/96.png",
        128: "icon/128.png",
      },
    },
    host_permissions: [
      "*://*.youtube.com/*",
      "*://*.instagram.com/*",
      "*://*.facebook.com/*",
      "*://*.tiktok.com/*",
    ],
  },
});
