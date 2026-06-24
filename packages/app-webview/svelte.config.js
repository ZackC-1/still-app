import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Enables <script lang="ts"> in the shared components consumed from @still/core.
export default {
  preprocess: vitePreprocess(),
};
