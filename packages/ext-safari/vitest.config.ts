import { defineConfig } from "vitest/config";

// Unit tests for the testable extension logic (lib/), not the WXT entrypoints. Node env — no DOM.
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
