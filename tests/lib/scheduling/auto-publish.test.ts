import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../../src/lib/ai/review-draft", () => ({ reviewAndReconcile: vi.fn() }));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, releases, webhookConfigs, deliveryAttempts } from "../../../src/db/schema";
import { runBatchForWorkspace } from "../../../src/lib/scheduling/run-schedule";
import { getPendingChangeItems } from "../../../src/lib/change-events/change-item-batch";
import { reviewAndReconcile } from "../../../src/lib/ai/review-draft";
import { encryptSecret } from "../../../src/lib/credentials/encryption";

const NAME = "Auto Publish Test Tenant";

const encryptedSecret = () => {
  const p = encryptSecret("s");
  return { secretCiphertext: p.ciphertext, secretIv: p.iv, secretAuthTag: p.authTag };
};

describe("runBatchForWorkspace auto-publish", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(reviewAndReconcile).mockImplementation(async (draft) => ({ finalDraft: draft, status: "passed", issues: [] }));
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
    await db.insert(changeEvents).values({
      tenantId: tenant.id, repoId: repo.id, type: "pull_request", provider: "github", externalId: "acme/x#1", status: "pending", prNumber: 1, prTitle: "a",
    });
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B", category: "new" },
    } as never);
    return tenant;
  }

  it("publishes and fires the webhook when autoPublish is on and an active webhook exists", async () => {
    const tenant = await seed(true);
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const pending = await getPendingChangeItems(tenant.id);
    await runBatchForWorkspace(tenant.id, pending);

    const [update] = await db.select().from(releases).where(eq(releases.tenantId, tenant.id));
    expect(update.status).toBe("published");
    expect(update.publishedAt).not.toBeNull();
    const deliveries = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.releaseId, update.id));
    expect(deliveries).toHaveLength(1);
  });

  it("publishes the revised draft (not the original) when the review revises it, and still fires the webhook", async () => {
    const tenant = await seed(true);
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(reviewAndReconcile).mockImplementation(async () => ({
      finalDraft: { title: "Revised title", body: "Revised body" },
      status: "passed",
      issues: [],
    }));

    const pending = await getPendingChangeItems(tenant.id);
    await runBatchForWorkspace(tenant.id, pending);

    const [update] = await db.select().from(releases).where(eq(releases.tenantId, tenant.id));
    expect(update.status).toBe("published");
    expect(update.reviewStatus).toBe("passed");
    expect(update.title).toBe("Revised title");
    expect(update.body).toBe("Revised body");
    const deliveries = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.releaseId, update.id));
    expect(deliveries).toHaveLength(1);
    expect(fetch).toHaveBeenCalled();
  });

  it("stays a draft when autoPublish is on but there is no active webhook", async () => {
    const tenant = await seed(true);

    const pending = await getPendingChangeItems(tenant.id);
    await runBatchForWorkspace(tenant.id, pending);

    const [update] = await db.select().from(releases).where(eq(releases.tenantId, tenant.id));
    expect(update.status).toBe("draft");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stays a draft (no publish) when the review fails, even with autoPublish + webhook", async () => {
    const tenant = await seed(true);
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });
    vi.mocked(reviewAndReconcile).mockImplementation(async (draft) => ({ finalDraft: draft, status: "failed", issues: ["too salesy"] }));

    const pending = await getPendingChangeItems(tenant.id);
    await runBatchForWorkspace(tenant.id, pending);

    const [update] = await db.select().from(releases).where(eq(releases.tenantId, tenant.id));
    expect(update.status).toBe("draft");
    expect(update.reviewStatus).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stays a draft (no publish) when the review errors", async () => {
    const tenant = await seed(true);
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });
    vi.mocked(reviewAndReconcile).mockImplementation(async (draft) => ({ finalDraft: draft, status: "error", issues: [] }));

    const pending = await getPendingChangeItems(tenant.id);
    await runBatchForWorkspace(tenant.id, pending);

    const [update] = await db.select().from(releases).where(eq(releases.tenantId, tenant.id));
    expect(update.status).toBe("draft");
    expect(update.reviewStatus).toBe("error");
    expect(fetch).not.toHaveBeenCalled();
  });
});
