import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

// Unit tests for the testable extension logic (lib/, node — no DOM), plus mount tests for the
// opted-in V3 popup and settings page (jsdom), mirroring ext-chromium's two projects.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "lib",
          environment: "node",
          include: ["lib/**/*.test.ts"],
        },
      },
      {
        plugins: [svelte(), svelteTesting()],
        test: {
          name: "popup",
          environment: "jsdom",
          globals: true,
          include: ["entrypoints/{popup,options,tiktok-blocked}/**/*.{test,spec}.ts"],
          exclude: ["**/*.css.test.ts", "**/node_modules/**"],
        },
      },
      // Mount tests that read computed styles: the components' and the design system's CSS is
      // processed and injected into jsdom (plain popup tests skip CSS for speed).
      {
        plugins: [svelte(), svelteTesting()],
        test: {
          name: "popup-css",
          environment: "jsdom",
          globals: true,
          css: true,
          include: ["entrypoints/popup/**/*.css.test.ts"],
        },
      },
    ],
  },
});
