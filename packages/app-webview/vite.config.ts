import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Builds the one shared Svelte UI (packages/core App.svelte) into a static index.html + assets that
// the Apple app's WKWebView loads from its bundle over file:// (KTD4, U17). The native App-Group
// bridge is the injected storage adapter (WKWebViewStorageAdapter), so this is the same UI the
// Chromium extension renders — only the persistence backing differs.
//
// `base: "./"` is required: a file:// page has an opaque origin, so absolute "/assets/..." URLs
// would not resolve inside the app bundle — every asset reference must be relative.
export default defineConfig({
  base: "./",
  plugins: [svelte()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "safari15", // WKWebView on the supported iOS/macOS floor
    modulePreload: { polyfill: false }, // single local entry, no preload graph needed over file://
  },
});
