import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, brandProfiles, systemPersonas, systemUpdateExamples } from "../../../src/db/schema";
import { prepareGenerationContext } from "../../../src/lib/ai/generation-context";

const TENANT_NAME = "Generation Context Test Tenant";

// systemPersonas and systemUpdateExamples are GLOBAL seeded catalogs (no
// tenantId column) — rows inserted here are visible to every other test in
// the suite for the duration of the test. Keys are unique to this file so
// they can't collide with the real seed data or another test file, and every
// insert is paired with a `finally`-guarded delete so a failed assertion
// can't strand a row for the rest of the run.
const PERSONA_KEY = "generation-context-test-persona";
const PERSONA_NAME = "Generation Context Test Persona";
const EXAMPLE_INDUSTRY = "Generation Context Test Industry";
const EXAMPLE_KEY_NEW = "generation-context-test-example-new";
const EXAMPLE_KEY_FIX = "generation-context-test-example-fix";

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  return tenant;
}

describe("prepareGenerationContext", () => {
  afterEach(async () => {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.name, TENANT_NAME));
    if (tenant) {
      await db.delete(brandProfiles).where(eq(brandProfiles.tenantId, tenant.id));
      await db.delete(tenants).where(eq(tenants.id, tenant.id));
    }
    // Safety net alongside each test's own try/finally: idempotent no-ops if
    // already cleaned up, but catches the case where cleanup was skipped.
    await db.delete(systemPersonas).where(eq(systemPersonas.key, PERSONA_KEY));
    await db.delete(systemUpdateExamples).where(eq(systemUpdateExamples.key, EXAMPLE_KEY_NEW));
    await db.delete(systemUpdateExamples).where(eq(systemUpdateExamples.key, EXAMPLE_KEY_FIX));
  });

  it("creates the brand profile on first use and returns personas and examples", async () => {
    const tenant = await seedTenant();

    const context = await prepareGenerationContext(tenant.id, db);

    expect(context.brandProfile.tenantId).toBe(tenant.id);
    expect(Array.isArray(context.personas)).toBe(true);
    expect(Array.isArray(context.examples)).toBe(true);

    // getOrCreateBrandProfile persisted it, so a second call reuses the row.
    const rows = await db.select().from(brandProfiles).where(eq(brandProfiles.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
  });

  it("resolves the tenant's configured personas", async () => {
    const tenant = await seedTenant();

    try {
      await db.insert(systemPersonas).values({
        key: PERSONA_KEY,
        name: PERSONA_NAME,
        description: "A persona seeded only for this test.",
        brief: "Write for this persona's needs.",
      });
      await prepareGenerationContext(tenant.id, db);
      await db
        .update(brandProfiles)
        .set({ userPersonas: [{ type: "system", key: PERSONA_KEY }] })
        .where(eq(brandProfiles.tenantId, tenant.id));

      const context = await prepareGenerationContext(tenant.id, db);

      // Match on the resolved persona's name, not just array length — length
      // alone would still pass if the wrong persona (or a stale/default one)
      // resolved instead of the one this tenant actually configured.
      expect(context.personas).toHaveLength(1);
      expect(context.personas[0]?.name).toBe(PERSONA_NAME);
    } finally {
      await db.delete(systemPersonas).where(eq(systemPersonas.key, PERSONA_KEY));
    }
  });

  it("passes categories through to example selection", async () => {
    const tenant = await seedTenant();

    try {
      // Both rows share an industry unique to this test, so both score
      // identically (industry match, no persona match) and both are
      // candidates regardless of `categories` — `selectExamples` filters
      // candidates by industry/persona match, then RANKS them by category
      // match as a tiebreaker (see src/lib/ai/select-examples.ts). So the
      // observable effect of `categories` here is ranking, not inclusion:
      // the "new" example has the lower sort_order, so it sorts first when
      // no category is requested; requesting "fix" should promote the fix
      // example ahead of it despite its higher sort_order.
      await db.insert(systemUpdateExamples).values([
        {
          key: EXAMPLE_KEY_NEW,
          industry: EXAMPLE_INDUSTRY,
          personaKey: null,
          category: "new",
          title: "New example",
          body: "Body for the new-category example.",
          sortOrder: 0,
        },
        {
          key: EXAMPLE_KEY_FIX,
          industry: EXAMPLE_INDUSTRY,
          personaKey: null,
          category: "fix",
          title: "Fix example",
          body: "Body for the fix-category example.",
          sortOrder: 1,
        },
      ]);
      // getOrCreateBrandProfile only creates the row on first use, and the
      // industry update below requires it to already exist.
      await prepareGenerationContext(tenant.id, db);
      await db
        .update(brandProfiles)
        .set({ industry: EXAMPLE_INDUSTRY })
        .where(eq(brandProfiles.tenantId, tenant.id));

      const withNone = await prepareGenerationContext(tenant.id, db);
      const withFix = await prepareGenerationContext(tenant.id, db, ["fix"]);

      expect(withNone.examples[0]?.key).toBe(EXAMPLE_KEY_NEW);
      expect(withFix.examples[0]?.key).toBe(EXAMPLE_KEY_FIX);
    } finally {
      await db.delete(systemUpdateExamples).where(eq(systemUpdateExamples.key, EXAMPLE_KEY_NEW));
      await db.delete(systemUpdateExamples).where(eq(systemUpdateExamples.key, EXAMPLE_KEY_FIX));
    }
  });
});
