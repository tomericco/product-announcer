import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { resolveConnectionString } from "./connection";

const pool = new Pool({
  connectionString: resolveConnectionString(),
  // Bounded so a fleet of warm Fluid Compute instances can't exhaust
  // Supabase's free-tier pooler connection budget. pg's default of 10 per
  // instance is too generous once several instances are warm.
  max: 5,
});

export const db = drizzle(pool, { schema });
