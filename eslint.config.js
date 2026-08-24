import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["convex/_generated/**", "node_modules/**", "frontend/**", "backend/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Convex ctx types in actions are legitimately loose where the
      // generated api types aren't available; flagged as warnings so
      // real problems aren't buried.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
