import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, updates, webhookConfigs, webhookDeliveries } from "../../../src/db/schema";
import { dispatchWebhookForUpdate, retryFailedWebhookDeliveries } from "../../../src/lib/publishing/webhook-delivery";

describe("webhook-delivery", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(tenants).where(eq(tenants.name, "Webhook Delivery Test Tenant"));
  });

  async function seed() {
    const [tenant] = await db.insert(tenants).values({ name: "Webhook Delivery Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    const [update] = await db
      .insert(updates)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        title: "T",
        body: "B",
        category: "new",
        status: "published",
        sourceItems: [],
      })
      .returning();
    return { tenant, repo, update };
  }

  it("records a successful delivery and signs the payload", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", secret: "s3cr3t" });

    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await dispatchWebhookForUpdate(update.id);

    const [call] = vi.mocked(fetch).mock.calls;
    expect(call[0]).toBe("https://example.com/hook");
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-product-announcer-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);

    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.updateId, update.id));
    expect(delivery.status).toBe("success");
    expect(delivery.attempts).toBe(1);
  });

  it("records a failed delivery without throwing when the endpoint errors", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", secret: "s3cr3t" });

    vi.mocked(fetch).mockRejectedValue(new Error("timeout"));

    await expect(dispatchWebhookForUpdate(update.id)).resolves.not.toThrow();

    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.updateId, update.id));
    expect(delivery.status).toBe("failed");
  });

  it("does nothing when the tenant has no active webhook config", async () => {
    const { update } = await seed();

    await dispatchWebhookForUpdate(update.id);

    const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.updateId, update.id));
    expect(deliveries).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retryFailedWebhookDeliveries retries failed deliveries under the attempt cap", async () => {
    const { tenant, update } = await seed();
    const [config] = await db
      .insert(webhookConfigs)
      .values({ tenantId: tenant.id, url: "https://example.com/hook", secret: "s3cr3t" })
      .returning();
    await db.insert(webhookDeliveries).values({
      updateId: update.id,
      webhookConfigId: config.id,
      status: "failed",
      attempts: 1,
    });

    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await retryFailedWebhookDeliveries();

    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.updateId, update.id));
    expect(delivery.status).toBe("success");
    expect(delivery.attempts).toBe(2);
  });

  it("retryFailedWebhookDeliveries skips deliveries that already hit the attempt cap", async () => {
    const { tenant, update } = await seed();
    const [config] = await db
      .insert(webhookConfigs)
      .values({ tenantId: tenant.id, url: "https://example.com/hook", secret: "s3cr3t" })
      .returning();
    await db.insert(webhookDeliveries).values({
      updateId: update.id,
      webhookConfigId: config.id,
      status: "failed",
      attempts: 3,
    });

    await retryFailedWebhookDeliveries();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("dispatchWebhookForUpdate never throws, even if a DB operation fails", async () => {
    const { update } = await seed();

    // A database whose first query throws simulates a DB error mid-dispatch.
    // Publish already committed before dispatch runs, so dispatch must swallow
    // this rather than propagate a 500 out of approveDraft.
    const brokenDb = {
      select: () => {
        throw new Error("db connection lost");
      },
    } as unknown as typeof db;

    await expect(dispatchWebhookForUpdate(update.id, brokenDb)).resolves.not.toThrow();
  });

  it("retryFailedWebhookDeliveries skips deliveries whose config was deactivated", async () => {
    const { tenant, update } = await seed();
    const [config] = await db
      .insert(webhookConfigs)
      .values({ tenantId: tenant.id, url: "https://example.com/hook", secret: "s3cr3t", active: false })
      .returning();
    await db.insert(webhookDeliveries).values({
      updateId: update.id,
      webhookConfigId: config.id,
      status: "failed",
      attempts: 1,
    });

    await retryFailedWebhookDeliveries();

    expect(fetch).not.toHaveBeenCalled();
    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.updateId, update.id));
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(1);
  });
});
