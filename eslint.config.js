import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "data/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts: no TypeScript, so declare the Node globals.
    files: ["scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    rules: {
      // The scripts lean on intentional empty catches for best-effort cleanup.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }
      ]
    }
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  },
  {
    // Test fixtures legitimately use any for row shapes.
    files: ["apps/server/test/**", "apps/server/scripts/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" }
  }
);
