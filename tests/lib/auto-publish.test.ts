import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems, updates, webhookConfigs, webhookDeliveries } from "../../src/db/schema";
import { runBatchForWorkspace } from "../../src/lib/run-schedule";
import { getPendingChangeItems } from "../../src/lib/change-item-batch";

const NAME = "Auto Publish Test Tenant";

describe("runBatchForWorkspace auto-publish", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(tenants).where(eq(tenants.name, NAME));
    vi.mocked(generateObject).mockReset();
  });

  async function seed(autoPublish: boolean) {
    const [tenant] = await db.insert(tenants).values({ name: NAME, autoPublish }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    await db.insert(changeItems).values({
      tenantId: tenant.id, repoId: repo.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a",
    });
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B", category: "new" },
    } as never);
    return tenant;
  }

  it("publishes and fires the webhook when autoPublish is on and an active webhook exists", async () => {
    const tenant = await seed(true);
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", secret: "s" });
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const pending = await getPendingChangeItems(tenant.id);
    await runBatchForWorkspace(tenant.id, pending);

    const [update] = await db.select().from(updates).where(eq(updates.tenantId, tenant.id));
    expect(update.status).toBe("published");
    expect(update.publishedAt).not.toBeNull();
    const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.updateId, update.id));
    expect(deliveries).toHaveLength(1);
  });

  it("stays a draft when autoPublish is on but there is no active webhook", async () => {
    const tenant = await seed(true);

    const pending = await getPendingChangeItems(tenant.id);
    await runBatchForWorkspace(tenant.id, pending);

    const [update] = await db.select().from(updates).where(eq(updates.tenantId, tenant.id));
    expect(update.status).toBe("draft");
    expect(fetch).not.toHaveBeenCalled();
  });
});
