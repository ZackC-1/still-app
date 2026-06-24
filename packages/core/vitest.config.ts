import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  test: {
    environment: "jsdom",
    globals: true,
    passWithNoTests: true,
    include: ["src/**/*.{test,spec}.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
