// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import svelte from "eslint-plugin-svelte";

export default tseslint.config(
  {
    ignores: [
      // Bundled Apple app resources (fonts and licenses) are not lint inputs.
      "apps/apple/Still/Shared (App)/Resources/**",
      // Harness-managed subagent worktrees (gitignored checkouts of this repo) — linting them
      // double-reports every file and breaks typescript-eslint's tsconfig root detection.
      "**/.claude/**",
      "**/dist/**",
      "**/.output/**",
      "**/.wxt/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/build/**",
      "**/DerivedData/**",
      "**/.build/**",
      "**/.swiftpm/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "**/.playwright/**",
      "**/*.config.js",
      "**/*.config.ts",
      // Supabase Edge Functions are Deno (jsr:/npm: imports, .ts extensions, Deno globals) —
      // linted by `deno lint`, not the Node ESLint flat config.
      "supabase/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    // Parse <script lang="ts"> blocks (and .svelte.ts rune modules) with the TS parser.
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-undef": "off", // TS handles this; avoids false positives on browser/chrome globals
    },
  },
  {
    // Tests deliberately construct malformed inputs to exercise validators/guards.
    files: ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
