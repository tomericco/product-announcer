import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // Only collect the test suite under tests/. Without this, vitest's default
    // glob picks up root config files that end in ".test.ts" (e.g.
    // drizzle.config.test.ts) and fails them as empty suites.
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
  },
});
