import { createHash } from "node:crypto";
import { defineConfig, loadEnv, type IndexHtmlTransformContext, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolvePublicConfig } from "./scripts/public-config.mjs";

// Builds the owner page into ONE self-contained dist/index.html: the script, the styles and the
// bundled Inter face are inlined, so the file can later be copied to an unlisted path on the
// website (an owner-approved step, see README.md) and loads nothing from anywhere else.
//
// Configuration. Only VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are read, validated (a server
// key fails the build) and compiled in as two constants. `envPrefix` matches no variable, so
// `import.meta.env` can never expose anything else. scripts/bundle-guard.mjs re-checks the output.
//
// Content-Security-Policy. GitHub Pages cannot send headers, so the policy is a <meta> written
// after inlining: default-src 'none', the exact sha256 of the one inline script and the one inline
// style, data: fonts and images, and connect-src limited to the configured project origin.

/** Where the policy goes: right after <meta charset>, before every inline element. */
const CSP_SLOT = "<!-- still-owner-admin:csp -->";
const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

function singleFilePage(origin: string | null): Plugin {
  const inlined = new Set<string>();
  return {
    name: "still-owner-admin-single-file",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html: string, ctx: IndexHtmlTransformContext) {
        const bundle = ctx.bundle;
        if (!bundle) return html; // dev server: no CSP, nothing to inline
        const fileOf = (url: string) => url.replace(/^\.?\//, "");
        const scripts: string[] = [];
        const styles: string[] = [];
        html = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (match, src: string) => {
          const chunk = bundle[fileOf(src)];
          if (!chunk || chunk.type !== "chunk") return match;
          inlined.add(chunk.fileName);
          // A literal "</script" inside the code would end the inline element early.
          const code = chunk.code.replace(/<\/script/gi, "<\\/script");
          scripts.push(code);
          return `<script type="module">${code}</script>`;
        });
        html = html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g, (match, href: string) => {
          const asset = bundle[fileOf(href)];
          if (!asset || asset.type !== "asset") return match;
          inlined.add(asset.fileName);
          const css = String(asset.source);
          styles.push(css);
          return `<style>${css}</style>`;
        });
        const policy = [
          "default-src 'none'",
          `script-src ${scripts.map(sha256).join(" ") || "'none'"}`,
          `style-src ${styles.map(sha256).join(" ") || "'none'"}`,
          "font-src data:",
          "img-src data:",
          `connect-src ${origin ?? "'none'"}`,
          "base-uri 'none'",
          "form-action 'none'",
          "object-src 'none'",
        ].join("; ");
        if (!html.includes(CSP_SLOT)) throw new Error("owner-admin: index.html lost its CSP slot");
        return html.replace(CSP_SLOT, `<meta http-equiv="Content-Security-Policy" content="${policy}">`);
      },
    },
    generateBundle(_options, bundle) {
      for (const fileName of inlined) delete bundle[fileName];
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const config = resolvePublicConfig({
    VITE_SUPABASE_URL: env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY,
  });
  return {
    base: "./",
    envPrefix: "STILL_OWNER_ADMIN_EXPOSES_NO_ENV_",
    define: {
      __STILL_SUPABASE_URL__: JSON.stringify(config.url),
      __STILL_SUPABASE_ANON_KEY__: JSON.stringify(config.anonKey),
    },
    plugins: [svelte(), singleFilePage(config.origin)],
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: "es2022",
      sourcemap: false,
      assetsInlineLimit: 500_000,
      cssCodeSplit: false,
      modulePreload: { polyfill: false },
      rollupOptions: { output: { codeSplitting: false } },
    },
  };
});
