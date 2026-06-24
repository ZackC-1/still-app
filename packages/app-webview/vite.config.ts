import { defineConfig, type IndexHtmlTransformContext, type Plugin } from "vite";
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
function inlineBundle(): Plugin {
  return {
    name: "still-inline-bundle",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html: string, ctx: IndexHtmlTransformContext) {
        const bundle = ctx.bundle;
        if (!bundle) return html;
        const fileOf = (url: string) => url.replace(/^\.?\//, "");

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
            return asset && asset.type === "asset"
              ? `<style>\n${asset.source}</style>`
              : match;
          },
        );

        return html;
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
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: { codeSplitting: false }, // one JS chunk → nothing left to fetch over file:// (Vite 8 replaces inlineDynamicImports)
    },
  },
});
