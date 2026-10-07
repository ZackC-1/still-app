// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import svelte from "eslint-plugin-svelte";

export default tseslint.config(
  {
    ignores: [
      // Pinned owner design references retain their original generated source bytes.
      "docs/design/Still v3.1 redesign/source/**",
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
    // Platform production code consumes the curated @still/core export map. Tests may inspect
    // physical sources/fixtures; build tooling retains ownership of generated rule inputs.
    files: [
      "packages/ext-chromium/**/*.{ts,svelte}",
      "packages/ext-safari/**/*.{ts,svelte}",
      "packages/app-webview/src/**/*.{ts,svelte}",
    ],
    ignores: ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(?!@still/core/).*(^|/)core/(src|rules)(/|$)|^@still/core/src(/|$)",
              message:
                "Use an explicit @still/core package export instead of a physical core path.",
            },
          ],
        },
      ],
      // no-restricted-imports covers static imports and re-exports, including type imports.
      // Apply the same boundary to lazy imports and import() types without changing loading.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportExpression[source.value=/core\\u002F(src|rules)(\\u002F|$)/]:not([source.value=/^@still\\u002Fcore\\u002Frules(\\u002F|$)/])",
          message:
            "Use an explicit @still/core package export for lazy imports.",
        },
        {
          selector:
            "TSImportType[source.value=/core\\u002F(src|rules)(\\u002F|$)/]:not([source.value=/^@still\\u002Fcore\\u002Frules(\\u002F|$)/])",
          message:
            "Use an explicit @still/core package export for import() types.",
        },
      ],
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
