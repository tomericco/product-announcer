import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  tenants,
  repos,
  updates,
  webhookConfigs,
  webflowConnections,
  deliveryAttempts,
  type WebflowFieldMapping,
} from "../../../src/db/schema";
import { dispatchAllDestinations, retryFailedDeliveries } from "../../../src/lib/publishing/dispatch";
import { encryptSecret } from "../../../src/lib/credentials/encryption";

const SECRET = "s3cr3t";
const encryptedSecret = () => {
  const p = encryptSecret(SECRET);
  return { secretCiphertext: p.ciphertext, secretIv: p.iv, secretAuthTag: p.authTag };
};

const encryptedToken = () => {
  const p = encryptSecret("wf-tok");
  return { tokenCiphertext: p.ciphertext, tokenIv: p.iv, tokenAuthTag: p.authTag };
};

const WEBFLOW_SCHEMA = {
  id: "c1",
  displayName: "Blog",
  slug: "blog",
  fields: [{ id: "f1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true }],
};

const webflowMapping: WebflowFieldMapping = { name: { source: "title" } };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("dispatch", () => {
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

  it("retryFailedDeliveries retries a failed Webflow delivery under the attempt cap", async () => {
    // retryFailedDeliveries was generalized from webhook-only to loop over all
    // registered destinations. Every other test in this describe block only
    // seeds a webhook row, so nothing proves the sweep actually reaches the
    // Webflow destination. This test is that proof.
    const { tenant, update } = await seed();
    await db.insert(webflowConnections).values({
      tenantId: tenant.id,
      ...encryptedToken(),
      siteId: "s1",
      collectionId: "c1",
      fieldMapping: webflowMapping,
      publishMode: "draft",
      status: "active",
    });
    await db.insert(deliveryAttempts).values({
      updateId: update.id,
      destination: "webflow",
      status: "failed",
      attempts: 1,
    });

    // A successful Webflow delivery is two fetch calls: fetch the collection
    // schema, then create (or update) the item.
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(WEBFLOW_SCHEMA)).mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    await retryFailedDeliveries();

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.updateId, update.id));
    expect(delivery.status).toBe("success");
    expect(delivery.attempts).toBe(2);
    expect(delivery.externalId).toBe("item1");
    expect(fetch).toHaveBeenCalledTimes(2);
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

  it("resets the retry budget on a fresh publish instead of accumulating across re-publishes", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });

    // Publish while the endpoint is down: attempts starts at 1, not accumulated.
    vi.mocked(fetch).mockRejectedValue(new Error("timeout"));
    await dispatchAllDestinations(update.id);

    let [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.updateId, update.id));
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(1);

    // Sweep it to exhaustion: 1 -> 2 -> 3.
    await retryFailedDeliveries();
    await retryFailedDeliveries();

    [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.updateId, update.id));
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(3);

    // A further sweep must skip it now that it's exhausted.
    await retryFailedDeliveries();
    expect(fetch).toHaveBeenCalledTimes(3); // the original publish + the 2 sweeps above

    // The operator fixes the endpoint and re-publishes, but it fails once more
    // transiently. Without the fix, this would push attempts to 4 and the row
    // would never be retried again.
    await dispatchAllDestinations(update.id);

    [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.updateId, update.id));
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(1);

    // And it's eligible for the sweep again: this call must actually retry it.
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    await retryFailedDeliveries();

    [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.updateId, update.id));
    expect(delivery.status).toBe("success");
    expect(delivery.attempts).toBe(2);
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
