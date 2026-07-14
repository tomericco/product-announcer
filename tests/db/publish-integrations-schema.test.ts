import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, updates, webhookConfigs, webhookDeliveries } from "../../src/db/schema";

describe("publish/integrations schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Publish Schema Test Tenant"));
  });

  it("links a WebhookDelivery to a WebhookConfig and an Update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Publish Schema Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    const [update] = await db
      .insert(updates)
      .values({ tenantId: tenant.id, repoId: repo.id, title: "T", body: "B", category: "new", sourceItems: [] })
      .returning();
    const [config] = await db
      .insert(webhookConfigs)
      .values({ tenantId: tenant.id, url: "https://example.com", secret: "s3cr3t" })
      .returning();

    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({ updateId: update.id, webhookConfigId: config.id })
      .returning();

    expect(delivery.status).toBe("pending");
    expect(delivery.attempts).toBe(0);
  });
});
