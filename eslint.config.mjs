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
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules,
  },
  {
    files: ["web/**/*.ts", "web/**/*.tsx"],
    ignores: ["web/.next/**", "web/next-env.d.ts", "web/node_modules/**"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./web/tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules,
  },
);
