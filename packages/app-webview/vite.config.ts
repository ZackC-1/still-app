import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Builds the one shared Svelte UI (packages/core App.svelte) into a SINGLE self-contained index.html
// the Apple app's WKWebView loads from its bundle over file:// (KTD4, U17). The native App-Group
// bridge is the injected storage adapter (WKWebViewStorageAdapter), so this is the same UI the
// Chromium extension renders — only the persistence backing differs.
//
// Why inline everything: a file:// page has an opaque origin, and ES module scripts are ALWAYS
// fetched with CORS semantics — so a separate `<script type="module" src="...">` (even without a
// `crossorigin` attribute) fails to load over file:// in WKWebView and the app never mounts (blank
// screen). Inlining the one JS chunk + CSS into the HTML removes every sub-resource fetch, so the
// inlined module executes directly with no network/CORS step.
//
// Why generateBundle (order "post") and not transformIndexHtml: Vite rewrites each dynamic
// `import()` as `__vitePreload(factory, __VITE_PRELOAD__)` and replaces that placeholder only in
// its own generateBundle step (vite:build-import-analysis), which runs AFTER the HTML transforms.
// Inlining from transformIndexHtml copied the chunk before that replacement, so a build with a
// dynamic import (the opted-in Apple V3 screens) shipped a raw `__VITE_PRELOAD__` and threw a
// ReferenceError in WKWebView. A post-ordered generateBundle sees the final chunk code — the same
// bytes Vite writes to assets/.
function inlineBundle(): Plugin {
  return {
    name: "still-inline-bundle",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const fileOf = (url: string) => url.replace(/^\.?\//, "");
        for (const page of Object.values(bundle)) {
          if (page.type !== "asset" || !page.fileName.endsWith(".html")) continue;
          let html =
            typeof page.source === "string" ? page.source : new TextDecoder().decode(page.source);

          html = html.replace(
            /<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g,
            (match, src: string) => {
              const chunk = bundle[fileOf(src)];
              return chunk && chunk.type === "chunk"
                ? `<script type="module">\n${chunk.code}</script>`
                : match;
            },
          );

          html = html.replace(
            /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g,
            (match, href: string) => {
              const asset = bundle[fileOf(href)];
              if (!asset || asset.type !== "asset") return match;
              const css =
                typeof asset.source === "string"
                  ? asset.source
                  : new TextDecoder().decode(asset.source);
              return `<style>\n${css}</style>`;
            },
          );

          page.source = html;
        }
      },
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [svelte(), inlineBundle()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "safari15", // WKWebView on the supported iOS/macOS floor
    // Keep the bundled Inter variable face inside index.html too; the native host intentionally
    // ships one self-contained WebUI file so file:// never performs a subresource fetch.
    assetsInlineLimit: 500_000,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: { codeSplitting: false }, // one JS chunk → nothing left to fetch over file:// (Vite 8 replaces inlineDynamicImports)
    },
  },
});
