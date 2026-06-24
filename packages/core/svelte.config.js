import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Enables <script lang="ts"> in components. WXT (ext-chromium/ext-safari) compiles these via
// @wxt-dev/module-svelte; core only needs this for its own component tests.
export default {
  preprocess: vitePreprocess(),
};
