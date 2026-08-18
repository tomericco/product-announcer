import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
// Extends Vitest's `expect` with the jest-dom matchers (toBeInTheDocument,
// etc.) for every test file in the jsdom project.
import "@testing-library/jest-dom/vitest";

// No TZ pin and no DATABASE_URL requirement here: this project doesn't talk
// to Postgres, and no current component test renders anything TZ-sensitive
// (see vitest.setup.ts for why the node project pins TZ). Add the pin here
// too if a future component test needs it.

// Unmount anything a test rendered so mounted trees don't leak into the
// next test.
afterEach(() => {
  cleanup();
});
