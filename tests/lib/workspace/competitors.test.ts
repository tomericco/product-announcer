import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants } from "../../../src/db/schema";
import { addCompetitor, listCompetitors } from "../../../src/lib/workspace/competitors";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "Competitors Lib Test Tenant";

describe("addCompetitor", () => {
  afterEach(async () => {
    await dropTenant(TENANT);
  });

  it("dedupes case-insensitively, keeping the first-seen spelling", async () => {
    const tenant = await seedTenant(TENANT);

    await addCompetitor(tenant.id, { name: "GitHub", websiteUrl: null });
    await addCompetitor(tenant.id, { name: "Github", websiteUrl: null });
    await addCompetitor(tenant.id, { name: "GITHUB", websiteUrl: null });

    const rows = await listCompetitors(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("GitHub");
  });

  it("backfills a null websiteUrl on a case-insensitive re-run that now knows one", async () => {
    const tenant = await seedTenant(TENANT);

    await addCompetitor(tenant.id, { name: "Jira", websiteUrl: null });
    const updated = await addCompetitor(tenant.id, { name: "jira", websiteUrl: "https://atlassian.com/jira" });

    expect(updated?.name).toBe("Jira");
    expect(updated?.websiteUrl).toBe("https://atlassian.com/jira");

    const rows = await listCompetitors(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].websiteUrl).toBe("https://atlassian.com/jira");
  });

  it("never overwrites an already-set websiteUrl with a different one", async () => {
    const tenant = await seedTenant(TENANT);

    await addCompetitor(tenant.id, { name: "Jira", websiteUrl: "https://atlassian.com/jira" });
    await addCompetitor(tenant.id, { name: "Jira", websiteUrl: "https://some-other-url.example" });

    const rows = await listCompetitors(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].websiteUrl).toBe("https://atlassian.com/jira");
  });

  it("still adds distinct competitors normally", async () => {
    const tenant = await seedTenant(TENANT);

    await addCompetitor(tenant.id, { name: "Jira", websiteUrl: null });
    await addCompetitor(tenant.id, { name: "Linear", websiteUrl: null });

    const rows = await listCompetitors(tenant.id);
    expect(rows.map((r) => r.name)).toEqual(["Jira", "Linear"]);
  });

  it("scopes the case-insensitive dedupe by tenant", async () => {
    const mine = await seedTenant(TENANT);
    const [other] = await db.insert(tenants).values({ name: TENANT + " Other" }).returning();
    try {
      await addCompetitor(mine.id, { name: "GitHub", websiteUrl: null });
      await addCompetitor(other.id, { name: "github", websiteUrl: null });

      expect(await listCompetitors(mine.id)).toHaveLength(1);
      expect(await listCompetitors(other.id)).toHaveLength(1);
    } finally {
      await db.delete(tenants).where(eq(tenants.id, other.id));
    }
  });
});
