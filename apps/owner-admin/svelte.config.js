import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Enables <script lang="ts"> here and in the shared core components this page reuses.
export default {
  preprocess: vitePreprocess(),
};
