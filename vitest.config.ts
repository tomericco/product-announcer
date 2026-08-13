import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    // Two projects, split by environment. The "node" project is the
    // pre-existing suite: it talks to a real Postgres via `pg` and must
    // never run under jsdom (see vitest.setup.ts for why). The "jsdom"
    // project is for component/hook tests that need a DOM — it gets its
    // own setup file with no database requirement.
    //
    // `environmentMatchGlobs` (the older way to route globs to
    // environments) was removed in this Vitest version (deprecated in v3);
    // `test.projects` is the supported replacement.
    projects: [
      {
        resolve: { alias },
        test: {
          name: "node",
          environment: "node",
          setupFiles: ["./vitest.setup.ts"],
          // Only collect the test suite under tests/. Without this, vitest's
          // default glob picks up root config files that end in ".test.ts"
          // (e.g. drizzle.config.test.ts) and fails them as empty suites.
          include: ["tests/**/*.{test,spec}.{ts,tsx}"],
          // tests/components/** belongs to the jsdom project below. Excluded
          // here so it isn't collected — and run — twice.
          exclude: ["tests/components/**"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "jsdom",
          environment: "jsdom",
          setupFiles: ["./vitest.setup.jsdom.ts"],
          include: ["tests/components/**/*.{test,spec}.{ts,tsx}"],
        },
      },
    ],
  },
});
