import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, updates, webhookConfigs, deliveryAttempts } from "../../../src/db/schema";
import { dispatchAllDestinations, retryFailedDeliveries } from "../../../src/lib/publishing/dispatch";
import { encryptSecret } from "../../../src/lib/credentials/encryption";

const SECRET = "s3cr3t";
const encryptedSecret = () => {
  const p = encryptSecret(SECRET);
  return { secretCiphertext: p.ciphertext, secretIv: p.iv, secretAuthTag: p.authTag };
};

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
        status: "published",
        sourceItems: [],
      })
      .returning();
    return { tenant, repo, update };
  }

  it("records a successful delivery and signs the payload", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });

    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await dispatchAllDestinations(update.id);

    const [call] = vi.mocked(fetch).mock.calls;
    expect(call[0]).toBe("https://example.com/hook");
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-product-announcer-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.updateId, update.id));
    expect(delivery.status).toBe("success");
    expect(delivery.attempts).toBe(1);
  });

  it("records a failed delivery without throwing when the endpoint errors", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });

    vi.mocked(fetch).mockRejectedValue(new Error("timeout"));

    await expect(dispatchAllDestinations(update.id)).resolves.not.toThrow();

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.updateId, update.id));
    expect(delivery.status).toBe("failed");
  });

  it("does nothing when the tenant has no active webhook config", async () => {
    const { update } = await seed();

    await dispatchAllDestinations(update.id);

    const deliveries = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.updateId, update.id));
    expect(deliveries).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retryFailedDeliveries retries failed deliveries under the attempt cap", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() }).returning();
    await db.insert(deliveryAttempts).values({
      updateId: update.id,
      destination: "webhook",
      status: "failed",
      attempts: 1,
    });

    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await retryFailedDeliveries();

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.updateId, update.id));
    expect(delivery.status).toBe("success");
    expect(delivery.attempts).toBe(2);
  });

  it("retryFailedDeliveries skips deliveries that already hit the attempt cap", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() }).returning();
    await db.insert(deliveryAttempts).values({
      updateId: update.id,
      destination: "webhook",
      status: "failed",
      attempts: 3,
    });

    await retryFailedDeliveries();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("dispatchAllDestinations never throws, even if a DB operation fails", async () => {
    const { update } = await seed();

    // A database whose first query throws simulates a DB error mid-dispatch.
    // Publish already committed before dispatch runs, so dispatch must swallow
    // this rather than propagate a 500 out of approveDraft.
    const brokenDb = {
      select: () => {
        throw new Error("db connection lost");
      },
    } as unknown as typeof db;

    await expect(dispatchAllDestinations(update.id, brokenDb)).resolves.not.toThrow();
  });

  it("retryFailedDeliveries skips deliveries whose config was deactivated", async () => {
    const { tenant, update } = await seed();
    await db
      .insert(webhookConfigs)
      .values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret(), active: false })
      .returning();
    await db.insert(deliveryAttempts).values({
      updateId: update.id,
      destination: "webhook",
      status: "failed",
      attempts: 1,
    });

    await retryFailedDeliveries();

    expect(fetch).not.toHaveBeenCalled();
    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.updateId, update.id));
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(1);
  });

  it("classifies a webhook secret decrypt failure as permanent and never calls fetch", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({
      tenantId: tenant.id,
      url: "https://example.com/hook",
      // Not a valid ciphertext for the configured CREDENTIALS_ENCRYPTION_KEY, so
      // decryptSecret throws.
      secretCiphertext: "not-valid-ciphertext",
      secretIv: "not-valid-iv",
      secretAuthTag: "not-valid-auth-tag",
    });

    await dispatchAllDestinations(update.id);

    expect(fetch).not.toHaveBeenCalled();

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.updateId, update.id));
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(3);
    expect(delivery.lastError).toMatch(/decrypt/i);
  });
});
