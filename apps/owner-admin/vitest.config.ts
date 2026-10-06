import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  define: {
    // Tests never see real configuration; components receive their config explicitly.
    __STILL_SUPABASE_URL__: JSON.stringify(""),
    __STILL_SUPABASE_ANON_KEY__: JSON.stringify(""),
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
