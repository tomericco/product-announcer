import { config } from "dotenv";
config({ path: ".env.local" });

import { defineConfig } from "drizzle-kit";

// Migrates the dedicated test database (TEST_DATABASE_URL). Keep it in sync with
// the dev schema by running `npm run db:migrate:test` whenever you add a
// migration — the vitest suite runs against this database, not the dev one.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.TEST_DATABASE_URL!,
  },
});
