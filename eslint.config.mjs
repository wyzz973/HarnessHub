// SPDX-License-Identifier: MIT
import tseslint from "typescript-eslint";

// Type-aware checks focus on lost asynchronous work and unsafe public contracts.
// TypeScript owns structural correctness; formatting is checked by Prettier.
const rules = {
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/ban-ts-comment": "error",
  "@typescript-eslint/consistent-type-imports": "error",
};
export default tseslint.config(
  {
    // The project service finds each file's project through the solution
    // tsconfig.json and reads workspace packages from source (the
    // @harnesshub/source condition), so linting needs no prior build.
    files: [
      "tests/**/*.ts",
      "packages/*/src/**/*.ts",
      "packages/*/test/**/*.ts",
      "apps/*/src/**/*.ts",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules,
  },
  {
    files: ["packages/console/**/*.ts", "packages/console/**/*.tsx"],
    ignores: [
      "packages/console/.next/**",
      "packages/console/next-env.d.ts",
      "packages/console/node_modules/**",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./packages/console/tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules,
  },
);
