import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { getServerSession } from "next-auth";
import { db } from "../../../src/db";
import { tenants, repos, releases, webhookConfigs, deliveryAttempts, users } from "../../../src/db/schema";
import { encryptSecret } from "../../../src/lib/credentials/encryption";
import { approveDraft, publishDraft } from "../../../src/app/(dashboard)/drafts/actions";

const TENANT_NAME = "Publish Idempotency Test Tenant";
const OTHER_TENANT_NAME = "Publish Idempotency Test Tenant (Other)";
const USER_EMAIL = "publish-idempotency-test@example.com";

function encryptedSecret() {
  const p = encryptSecret("s3cr3t");
  return { secretCiphertext: p.ciphertext, secretIv: p.iv, secretAuthTag: p.authTag };
}

async function seed(tenantName = TENANT_NAME) {
  const [tenant] = await db.insert(tenants).values({ name: tenantName }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  const [repo] = await db
    .insert(repos)
    .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
    .returning();
  await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });
  const [update] = await db
    .insert(releases)
    .values({
      tenantId: tenant.id,
      repoId: repo.id,
      title: "Original title",
      body: "Original body",
      status: "draft",
      sourceItems: [],
    })
    .returning();
  return { tenant, repo, update, user };
}

async function rowFor(releaseId: string) {
  const [row] = await db.select().from(releases).where(eq(releases.id, releaseId));
  return row;
}

async function deliveriesFor(releaseId: string) {
  return db.select().from(deliveryAttempts).where(eq(deliveryAttempts.releaseId, releaseId));
}

function approveFormData(releaseId: string, publishedAt: string) {
  const fd = new FormData();
  fd.set("releaseId", releaseId);
  fd.set("title", "Original title");
  fd.set("body", "Original body");
  fd.set("publishedAt", publishedAt);
  return fd;
}

function publishFormData(releaseId: string, publishedAt: string) {
  const fd = new FormData();
  fd.set("releaseId", releaseId);
  fd.set("publishedAt", publishedAt);
  return fd;
}

describe("draft publish idempotency (approveDraft / publishDraft)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
    await db.delete(tenants).where(eq(tenants.name, OTHER_TENANT_NAME));
    await db.delete(users).where(eq(users.email, USER_EMAIL));
  });

  describe("approveDraft", () => {
    it("first publish of a never-published draft works (expected published_at = null)", async () => {
      const { tenant, update, user } = await seed();
      vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      await approveDraft(approveFormData(update.id, ""));

      const row = await rowFor(update.id);
      expect(row.status).toBe("published");
      expect(row.publishedAt).not.toBeNull();

      const deliveries = await deliveriesFor(update.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].attempts).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("two calls carrying the SAME expected published_at (a double submit) deliver exactly once", async () => {
      const { tenant, update, user } = await seed();
      vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      const formData = approveFormData(update.id, "");
      await approveDraft(formData);
      // Simulate the double-click resubmitting the identical, already-rendered
      // form — same expected published_at ("").
      await approveDraft(approveFormData(update.id, ""));

      const deliveries = await deliveriesFor(update.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].attempts).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("an intentional re-publish — fresh page load, then Approve — still delivers, reusing the same delivery_attempts row", async () => {
      const { tenant, update, user } = await seed();
      vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      await approveDraft(approveFormData(update.id, ""));
      const [deliveryAfterFirst] = await deliveriesFor(update.id);
      expect(fetch).toHaveBeenCalledTimes(1);

      // A fresh page load renders the CURRENT published_at into the hidden
      // field this time.
      const current = await rowFor(update.id);
      const currentPublishedAt = current.publishedAt!.toISOString();

      await approveDraft(approveFormData(update.id, currentPublishedAt));

      expect(fetch).toHaveBeenCalledTimes(2);
      const deliveries = await deliveriesFor(update.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].id).toBe(deliveryAfterFirst.id);
      expect(deliveries[0].attempts).toBe(1);
    });

    it("tenant isolation: another tenant cannot approve this update", async () => {
      const { update } = await seed();
      const [otherTenant] = await db.insert(tenants).values({ name: OTHER_TENANT_NAME }).returning();
      vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: otherTenant.id, id: "u2" } } as never);

      await expect(approveDraft(approveFormData(update.id, ""))).rejects.toThrow();

      const row = await rowFor(update.id);
      expect(row.status).toBe("draft");
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe("publishDraft", () => {
    it("first publish of a never-published draft works (expected published_at = null)", async () => {
      const { tenant, update, user } = await seed();
      vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      await publishDraft(publishFormData(update.id, ""));

      const row = await rowFor(update.id);
      expect(row.status).toBe("published");
      expect(row.publishedAt).not.toBeNull();

      const deliveries = await deliveriesFor(update.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].attempts).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("two calls carrying the SAME expected published_at (a double submit) deliver exactly once", async () => {
      const { tenant, update, user } = await seed();
      vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      await publishDraft(publishFormData(update.id, ""));
      await publishDraft(publishFormData(update.id, ""));

      const deliveries = await deliveriesFor(update.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].attempts).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("an intentional re-publish with the CURRENT published_at still delivers, reusing the same delivery_attempts row", async () => {
      const { tenant, update, user } = await seed();
      vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      await publishDraft(publishFormData(update.id, ""));
      const [deliveryAfterFirst] = await deliveriesFor(update.id);

      const current = await rowFor(update.id);
      const currentPublishedAt = current.publishedAt!.toISOString();

      await publishDraft(publishFormData(update.id, currentPublishedAt));

      expect(fetch).toHaveBeenCalledTimes(2);
      const deliveries = await deliveriesFor(update.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].id).toBe(deliveryAfterFirst.id);
    });

    it("tenant isolation: another tenant cannot publish this update", async () => {
      const { update } = await seed();
      const [otherTenant] = await db.insert(tenants).values({ name: OTHER_TENANT_NAME }).returning();
      vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: otherTenant.id, id: "u2" } } as never);

      await expect(publishDraft(publishFormData(update.id, ""))).rejects.toThrow();

      const row = await rowFor(update.id);
      expect(row.status).toBe("draft");
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
