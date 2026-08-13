import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: () => {} })) }));

import { getServerSession } from "next-auth";
import { db } from "../../../src/db";
import { tenants, atomicUpdates, contentPieces, users, tenantMembers } from "../../../src/db/schema";
import { linkAtomicUpdatesToPiece } from "../../../src/lib/change-events/release-claim";
import { approveDraft, publishDraft, checkDraftLinks } from "../../../src/app/(dashboard)/drafts/actions";

const TENANT_NAME = "Publish Invalid Links Test Tenant";
const USER_EMAIL = "publish-invalid-links-test@example.com";

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: user.id, role: "owner" });
  vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
  return { tenant, user };
}

async function seedDraft(tenantId: string, body: string) {
  const [au] = await db.insert(atomicUpdates).values({ tenantId, title: "A", summary: "S" }).returning();
  const [release] = await db.insert(contentPieces).values({ tenantId, title: "R", body }).returning();
  await linkAtomicUpdatesToPiece({ tenantId, contentPieceId: release.id, atomicUpdateIds: [au.id] });
  return { release, atomicUpdateId: au.id };
}

function formDataFor(releaseId: string, body: string) {
  const fd = new FormData();
  fd.set("contentPieceId", releaseId);
  fd.set("title", "R");
  fd.set("body", body);
  fd.set("publishedAt", "");
  fd.append("destinations", "webhook");
  return fd;
}

async function assertUnpublished(releaseId: string, atomicUpdateId: string) {
  const [row] = await db.select().from(contentPieces).where(eq(contentPieces.id, releaseId));
  expect(row.status).toBe("draft");
  expect(row.publishedAt).toBeNull();
  const [au] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomicUpdateId));
  expect(au.status).toBe("open");
}

describe("publishing is blocked when the body has invalid links", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
    await db.delete(users).where(eq(users.email, USER_EMAIL));
  });

  it("approveDraft returns a placeholder problem and does not publish", async () => {
    const { tenant } = await seed();
    const { release, atomicUpdateId } = await seedDraft(tenant.id, "Original body");

    const result = await approveDraft(formDataFor(release.id, "See the docs [add link] for details."));

    expect(result?.problems.some((p) => p.reason === "placeholder")).toBe(true);
    await assertUnpublished(release.id, atomicUpdateId);
  });

  it("approveDraft returns a malformed-link problem and does not publish", async () => {
    const { tenant } = await seed();
    const { release, atomicUpdateId } = await seedDraft(tenant.id, "Original body");

    const result = await approveDraft(formDataFor(release.id, "Read the [guide](htp://typo.example)."));

    expect(result?.problems.some((p) => p.reason === "malformed")).toBe(true);
    await assertUnpublished(release.id, atomicUpdateId);
  });

  it("publishDraft returns problems for a stored body with an invalid link and does not publish", async () => {
    const { tenant } = await seed();
    const { release, atomicUpdateId } = await seedDraft(tenant.id, "Grab it here [add link].");

    const fd = new FormData();
    fd.set("contentPieceId", release.id);
    fd.set("publishedAt", "");

    const result = await publishDraft(fd);

    expect(result?.problems.length).toBeGreaterThan(0);
    await assertUnpublished(release.id, atomicUpdateId);
  });

  it("checkDraftLinks reports problems for the submitted body without publishing", async () => {
    const { tenant } = await seed();
    const { release, atomicUpdateId } = await seedDraft(tenant.id, "Original body");

    const fd = new FormData();
    fd.set("contentPieceId", release.id);
    fd.set("body", "See the docs [add link] here.");

    const { problems } = await checkDraftLinks(fd);
    expect(problems.some((p) => p.reason === "placeholder")).toBe(true);
    await assertUnpublished(release.id, atomicUpdateId);
  });

  it("checkDraftLinks returns no problems for a clean submitted body", async () => {
    const { tenant } = await seed();
    const { release } = await seedDraft(tenant.id, "Original body");

    const fd = new FormData();
    fd.set("contentPieceId", release.id);
    fd.set("body", "A perfectly clean body.");

    const { problems } = await checkDraftLinks(fd);
    expect(problems).toEqual([]);
  });

  it("approveDraft publishes normally when the body has no links", async () => {
    const { tenant } = await seed();
    const { release, atomicUpdateId } = await seedDraft(tenant.id, "Clean body");

    const result = await approveDraft(formDataFor(release.id, "A perfectly clean body."));

    expect(result).toBeUndefined();
    const [row] = await db.select().from(contentPieces).where(eq(contentPieces.id, release.id));
    expect(row.status).toBe("published");
    const [au] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomicUpdateId));
    expect(au.status).toBe("released");
  });
});
