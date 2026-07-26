import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: () => {} })) }));

import { getServerSession } from "next-auth";
import { db } from "../../../src/db";
import { tenants, atomicUpdates, users, tenantMembers } from "../../../src/db/schema";
import { claimReleaseFromAtomicUpdates } from "../../../src/lib/change-events/release-claim";
import { approveDraft, publishDraft } from "../../../src/app/(dashboard)/drafts/actions";

const TENANT_NAME = "Publish Releases Atomic Updates Test Tenant";
const USER_EMAIL = "publish-releases-atomic-updates-test@example.com";

async function seedTenantAndUser() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: user.id, role: "owner" });
  return { tenant, user };
}

async function atomicUpdatesFor(releaseId: string) {
  return db.select().from(atomicUpdates).where(eq(atomicUpdates.releaseId, releaseId));
}

// approveDraft now requires the form to name at least one valid destination
// (publishDraft ignores the field). Default to "webhook" so these
// atomic-update-status tests publish successfully; delivery itself is a no-op
// here since no webhook/webflow config is seeded (dispatch skips it).
function formDataFor(releaseId: string, publishedAt: string, destinations: string[] = ["webhook"]) {
  const fd = new FormData();
  fd.set("releaseId", releaseId);
  fd.set("title", "R");
  fd.set("body", "B");
  fd.set("publishedAt", publishedAt);
  for (const d of destinations) fd.append("destinations", d);
  return fd;
}

describe("publishing a draft releases its atomic updates", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
    await db.delete(users).where(eq(users.email, USER_EMAIL));
  });

  it("approveDraft flips a claimed atomic update from open to released", async () => {
    const { tenant, user } = await seedTenantAndUser();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

    const [au] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "A", summary: "S" })
      .returning();
    const release = await claimReleaseFromAtomicUpdates({
      tenantId: tenant.id,
      atomicUpdateIds: [au.id],
      draft: { title: "R", body: "B" },
    });
    expect(release).not.toBeNull();

    // Still open while in a draft, per the open-until-publish lifecycle.
    const beforePublish = await atomicUpdatesFor(release!.id);
    expect(beforePublish.every((a) => a.status === "open")).toBe(true);

    await approveDraft(formDataFor(release!.id, ""));

    const afterPublish = await atomicUpdatesFor(release!.id);
    expect(afterPublish).toHaveLength(1);
    expect(afterPublish.every((a) => a.status === "released")).toBe(true);
  });

  it("publishDraft flips a claimed atomic update from open to released", async () => {
    const { tenant, user } = await seedTenantAndUser();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

    const [au] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "A", summary: "S" })
      .returning();
    const release = await claimReleaseFromAtomicUpdates({
      tenantId: tenant.id,
      atomicUpdateIds: [au.id],
      draft: { title: "R", body: "B" },
    });
    expect(release).not.toBeNull();

    await publishDraft(formDataFor(release!.id, ""));

    const afterPublish = await atomicUpdatesFor(release!.id);
    expect(afterPublish).toHaveLength(1);
    expect(afterPublish.every((a) => a.status === "released")).toBe(true);
  });

  it("a double-submit second call does not error and atomic updates stay released", async () => {
    const { tenant, user } = await seedTenantAndUser();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

    const [au] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "A", summary: "S" })
      .returning();
    const release = await claimReleaseFromAtomicUpdates({
      tenantId: tenant.id,
      atomicUpdateIds: [au.id],
      draft: { title: "R", body: "B" },
    });
    expect(release).not.toBeNull();

    await publishDraft(formDataFor(release!.id, ""));
    // Second call still names the original (now-stale) expected publishedAt
    // ("") — the publish UPDATE matches zero rows, so this must be a no-op,
    // not a second `markReleaseAtomicUpdatesReleased` call erroring out.
    await publishDraft(formDataFor(release!.id, ""));

    const afterPublish = await atomicUpdatesFor(release!.id);
    expect(afterPublish).toHaveLength(1);
    expect(afterPublish.every((a) => a.status === "released")).toBe(true);
  });
});
