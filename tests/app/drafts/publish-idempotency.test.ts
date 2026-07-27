import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: () => {} })) }));

import { getServerSession } from "next-auth";
import { db } from "../../../src/db";
import { tenants, repos, releases, webhookConfigs, webflowConnections, deliveryAttempts, users, tenantMembers } from "../../../src/db/schema";
import { encryptSecret } from "../../../src/lib/credentials/encryption";
import { approveDraft, publishDraft } from "../../../src/app/(dashboard)/drafts/actions";

const TENANT_NAME = "Publish Idempotency Test Tenant";
const OTHER_TENANT_NAME = "Publish Idempotency Test Tenant (Other)";
const USER_EMAIL = "publish-idempotency-test@example.com";
const OTHER_USER_EMAIL = "publish-idempotency-test-other@example.com";

function encryptedSecret() {
  const p = encryptSecret("s3cr3t");
  return { secretCiphertext: p.ciphertext, secretIv: p.iv, secretAuthTag: p.authTag };
}

function encryptedToken() {
  const p = encryptSecret("wf-tok");
  return { tokenCiphertext: p.ciphertext, tokenIv: p.iv, tokenAuthTag: p.authTag };
}

async function seed(tenantName = TENANT_NAME) {
  const [tenant] = await db.insert(tenants).values({ name: tenantName }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: user.id, role: "owner" });
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
    })
    .returning();
  return { tenant, repo, update, user };
}

// A real member of a SEPARATE tenant — used by the tenant-isolation tests so
// requireSession() resolves to a genuine, membership-checked otherTenant
// (not just a session literal claiming otherTenant.id). This makes the
// isolation assertion exercise the action's own `WHERE tenantId` guard
// (loadOwnedDraft throwing "Update not found for this tenant") rather than
// an unrelated failure earlier in the call chain.
async function seedOtherTenantMember() {
  const [otherTenant] = await db.insert(tenants).values({ name: OTHER_TENANT_NAME }).returning();
  const [otherUser] = await db.insert(users).values({ email: OTHER_USER_EMAIL }).returning();
  await db.insert(tenantMembers).values({ tenantId: otherTenant.id, userId: otherUser.id, role: "owner" });
  return { otherTenant, otherUser };
}

async function rowFor(releaseId: string) {
  const [row] = await db.select().from(releases).where(eq(releases.id, releaseId));
  return row;
}

async function deliveriesFor(releaseId: string) {
  return db.select().from(deliveryAttempts).where(eq(deliveryAttempts.releaseId, releaseId));
}

function approveFormData(releaseId: string, publishedAt: string, destinations: string[] = ["webhook"]) {
  const fd = new FormData();
  fd.set("releaseId", releaseId);
  fd.set("title", "Original title");
  fd.set("body", "Original body");
  fd.set("publishedAt", publishedAt);
  for (const d of destinations) fd.append("destinations", d);
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
    await db.delete(users).where(eq(users.email, OTHER_USER_EMAIL));
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
      expect(row.publishedBy).toBe(user.id);

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
      const { otherUser } = await seedOtherTenantMember();
      vi.mocked(getServerSession).mockResolvedValue({ user: { id: otherUser.id } } as never);

      // Must reject via the action's own `WHERE tenantId` guard
      // (loadOwnedDraft), not some unrelated failure — otherwise this test
      // would still pass even if that guard were deleted.
      await expect(approveDraft(approveFormData(update.id, ""))).rejects.toThrow(
        "Update not found for this tenant"
      );

      const row = await rowFor(update.id);
      expect(row.status).toBe("draft");
      expect(fetch).not.toHaveBeenCalled();
    });

    it("publishes only to the destinations named in the form", async () => {
      const { tenant, update, user } = await seed();
      // A second, fully-configured destination so the filtering is observable.
      await db.insert(webflowConnections).values({
        tenantId: tenant.id, ...encryptedToken(), siteId: "s1", collectionId: "c1",
        fieldMapping: { name: { source: "title" } }, publishMode: "draft", status: "active",
      });
      vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      await approveDraft(approveFormData(update.id, "", ["webhook"]));

      const deliveries = await deliveriesFor(update.id);
      expect(deliveries.map((d) => d.destination)).toEqual(["webhook"]);
    });

    it("rejects a publish that names no destinations, leaving the draft unpublished", async () => {
      const { tenant, update, user } = await seed();
      vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

      await expect(approveDraft(approveFormData(update.id, "", []))).rejects.toThrow();

      const row = await rowFor(update.id);
      expect(row.status).toBe("draft");
      expect(fetch).not.toHaveBeenCalled();
      expect(await deliveriesFor(update.id)).toHaveLength(0);
    });

    it("rejects a publish whose destinations are all unrecognized", async () => {
      const { tenant, update, user } = await seed();
      vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

      await expect(approveDraft(approveFormData(update.id, "", ["bogus"]))).rejects.toThrow();

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
      expect(row.publishedBy).toBe(user.id);

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
      const { otherUser } = await seedOtherTenantMember();
      vi.mocked(getServerSession).mockResolvedValue({ user: { id: otherUser.id } } as never);

      // Must reject via the action's own `WHERE tenantId` guard
      // (loadOwnedDraft), not some unrelated failure — otherwise this test
      // would still pass even if that guard were deleted.
      await expect(publishDraft(publishFormData(update.id, ""))).rejects.toThrow(
        "Update not found for this tenant"
      );

      const row = await rowFor(update.id);
      expect(row.status).toBe("draft");
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
