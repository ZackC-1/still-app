import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

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
          include: ["entrypoints/{popup,options,first-run}/**/*.{test,spec}.ts"],
        },
      },
    ],
  },
});
