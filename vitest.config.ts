import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // convex-test runs functions in an environment that matches Convex's
    // own runtime rather than Node's, so schema validation, index
    // behaviour and vector search behave as they do on a deployment.
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["convex/**/*.itest.ts"],
  },
});
