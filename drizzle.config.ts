import { config } from "dotenv";
config({ path: ".env.local" });

import { defineConfig } from "drizzle-kit";
import { normalizeConnectionString } from "./src/db/connection";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    // Supabase's pooled connection (POSTGRES_URL) runs in transaction mode and
    // does not hold a session across statements, which migrations need.
    // POSTGRES_URL_NON_POOLING is the direct connection Vercel injects; it is
    // unset locally, so DATABASE_URL still applies during development.
    url: normalizeConnectionString(
      process.env.POSTGRES_URL_NON_POOLING ?? process.env.DATABASE_URL!
    )!,
  },
});
