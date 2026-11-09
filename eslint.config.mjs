import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

import boundaries from "./eslint.boundaries.mjs";

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "coverage/**", "next-env.d.ts"] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: ["error", "always"],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      // Money is integer minor units (CLAUDE.md). Float parsing needs an explicit, reviewed opt-out.
      "no-restricted-properties": [
        "error",
        { object: "Number", property: "parseFloat", message: "No float math on money." },
      ],
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "No float math on money; use integer minor units." },
      ],
    },
  },

  // JS config files are not in the TS project.
  { files: ["**/*.mjs"], ...tseslint.configs.disableTypeChecked },

  ...boundaries,
  prettier,
);
