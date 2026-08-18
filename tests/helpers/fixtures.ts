import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants } from "../../src/db/schema";

/**
 * Seeds a tenant by name. The name is the cleanup key — `dropTenant` deletes
 * by it and every child row cascades — so each test file must use a name
 * unique to that file, or two files running against this shared Postgres will
 * delete each other's fixtures mid-run.
 */
export async function seedTenant(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  return tenant;
}

/** Teardown counterpart. Cascades to every table keyed on the tenant. */
export async function dropTenant(name: string) {
  await db.delete(tenants).where(eq(tenants.name, name));
}
