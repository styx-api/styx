import js from "@eslint/js";
import ts from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import svelteParser from "svelte-eslint-parser";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The playground runs in the browser (Vite + Svelte 5).
    files: ["playground/**/*.{ts,svelte}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        // Build-time constants injected via Vite `define` (see playground/vite.config.ts).
        __STYX_VERSION__: "readonly",
        __STYX_COMMIT__: "readonly",
        __BUILD_DATE__: "readonly",
      },
    },
  },
  {
    files: ["**/*.svelte"],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: ts.parser,
      },
    },
  },
  {
    // Node tooling scripts (e.g. the codegen typecheck gate).
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    ignores: [
      "**/dist",
      "**/node_modules",
      "**/.svelte-kit",
      "**/__snapshots__",
      ".tmp-codegen-typecheck",
    ],
  },
];
