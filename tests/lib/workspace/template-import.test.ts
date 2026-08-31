import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { companyProfiles } from "../../../src/db/schema";
import { importProductUpdateTemplateForTenant } from "../../../src/lib/workspace/template-import";
import { getOrCreateCompanyProfile } from "../../../src/lib/workspace/company-profile";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const NAME = "Template Import Test Tenant";

const PAGE = { text: "page", html: "", finalUrl: "u", contentType: "text/html", truncated: false };

describe("importProductUpdateTemplateForTenant", () => {
  afterEach(async () => {
    await dropTenant(NAME);
  });

  it("scrapes, derives, and writes the template and the url", async () => {
    const tenant = await seedTenant(NAME);

    const result = await importProductUpdateTemplateForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => PAGE,
      derive: async () => "# What's new\n\n## Highlights\n",
    });

    expect(result.ok).toBe(true);
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.productUpdateTemplate).toBe("# What's new\n\n## Highlights\n");
    expect(profile.updatesPageUrl).toBe("https://acme.com/changelog");
  });

  it("writes nothing and reports analysis-empty when the page yields no structure", async () => {
    const tenant = await seedTenant(NAME);
    const profile = await getOrCreateCompanyProfile(tenant.id);
    await db
      .update(companyProfiles)
      .set({ productUpdateTemplate: "# Hand written\n" })
      .where(eq(companyProfiles.id, profile.id));

    const result = await importProductUpdateTemplateForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => PAGE,
      derive: async () => null,
    });

    expect(result).toEqual({ ok: false, reason: "analysis-empty" });
    // Null on this column selects the pre-template prompt, so a null write
    // would be indistinguishable from "never configured" — an import that
    // silently cleared a hand-written template is the failure this pins.
    const [after] = await db.select().from(companyProfiles).where(eq(companyProfiles.id, profile.id));
    expect(after.productUpdateTemplate).toBe("# Hand written\n");
  });

  it("writes nothing and reports the reason on a scrape error", async () => {
    const tenant = await seedTenant(NAME);

    const result = await importProductUpdateTemplateForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => ({ error: "blocked" as const }),
      derive: async () => "# Should not be reached\n",
    });

    expect(result).toEqual({ ok: false, reason: "blocked" });
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile).toBeUndefined();
  });

  it("never writes guidelines or industry — those are brand-import's columns", async () => {
    const tenant = await seedTenant(NAME);
    const profile = await getOrCreateCompanyProfile(tenant.id);
    await db
      .update(companyProfiles)
      .set({ guidelines: "Be brief.", industry: "SaaS" })
      .where(eq(companyProfiles.id, profile.id));

    await importProductUpdateTemplateForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => PAGE,
      derive: async () => "# What's new\n\n## Highlights\n",
    });

    const [after] = await db.select().from(companyProfiles).where(eq(companyProfiles.id, profile.id));
    expect(after.guidelines).toBe("Be brief.");
    expect(after.industry).toBe("SaaS");
  });
});
