import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules", "out", "coverage", "docs/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["build/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { __dirname: "readonly", module: "readonly", process: "readonly", require: "readonly", URL: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["scripts/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", URL: "readonly" },
    },
  },
  {
    files: ["tests/fixtures/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", queueMicrotask: "readonly" },
    },
  },
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts", "*.ts"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { "allowConstantExport": true }],
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    },
  },
);
