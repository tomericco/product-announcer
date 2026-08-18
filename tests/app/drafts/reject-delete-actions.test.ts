import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces, users, atomicUpdates } from "../../../src/db/schema";

const TENANT_NAME = "Reject Delete Actions Test Tenant";
const USER_EMAIL = "reject-delete-actions-test@example.com";
let currentTenantId = "";
let currentUserId: string | null = null;

// requireSession() returns a NextAuth Session (tenantId lives under `user`) —
// mirror that shape rather than a flat one, per the existing actions-test
// mocking style (see tests/app/atomic-updates-actions.test.ts).
vi.mock("../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { rejectDraft, deleteDraft } from "../../../src/app/(dashboard)/drafts/actions";

/**
 * Seeds a release plus one atomic update linked to it. `status` controls the
 * release's state; the atomic update mirrors what that state implies — still
 * `open` while the release is a draft, `released` once it has published.
 */
async function seed(status: "draft" | "published" = "draft") {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  currentTenantId = tenant.id;
  currentUserId = user.id;
  const [release] = await db
    .insert(contentPieces)
    .values({
      tenantId: tenant.id,
      title: "T",
      body: "B",
      status,
      ...(status === "published" ? { publishedAt: new Date() } : {}),
    })
    .returning();
  const [atomic] = await db
    .insert(atomicUpdates)
    .values({
      tenantId: tenant.id,
      contentPieceId: release.id,
      title: "CSV export",
      summary: "Export reports as CSV.",
      status: status === "published" ? "released" : "open",
    })
    .returning();
  return { tenant, user, release, atomic };
}

function formDataFor(releaseId: string) {
  const fd = new FormData();
  fd.set("contentPieceId", releaseId);
  return fd;
}

async function releaseRow(releaseId: string) {
  const [row] = await db.select().from(contentPieces).where(eq(contentPieces.id, releaseId));
  return row;
}

async function atomicRow(id: string) {
  const [row] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, id));
  return row;
}

afterEach(async () => {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.name, TENANT_NAME));
  if (tenant) {
    await db.delete(atomicUpdates).where(eq(atomicUpdates.tenantId, tenant.id));
    await db.delete(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
  }
  await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
  await db.delete(users).where(eq(users.email, USER_EMAIL));
});

describe("rejectDraft", () => {
  it("rejects a draft and hands its atomic updates back to the pool", async () => {
    const { release, atomic } = await seed("draft");

    await rejectDraft(formDataFor(release.id));

    expect((await releaseRow(release.id)).status).toBe("archived");
    const reverted = await atomicRow(atomic.id);
    expect(reverted.status).toBe("open");
    expect(reverted.contentPieceId).toBeNull();
  });

  // The damage this prevents is specific: reverting a published release's
  // atomic updates would flip work that already shipped back to `open`, so the
  // compose list would offer it up for a brand-new draft.
  it("refuses a published release, leaving its released atomic updates closed", async () => {
    const { release, atomic } = await seed("published");

    await expect(rejectDraft(formDataFor(release.id))).rejects.toThrow(/already been published/i);

    expect((await releaseRow(release.id)).status).toBe("published");
    const untouched = await atomicRow(atomic.id);
    expect(untouched.status).toBe("released");
    expect(untouched.contentPieceId).toBe(release.id);
  });
});

describe("deleteDraft", () => {
  it("deletes a draft and hands its atomic updates back to the pool", async () => {
    const { release, atomic } = await seed("draft");

    await deleteDraft(formDataFor(release.id));

    expect(await releaseRow(release.id)).toBeUndefined();
    const reverted = await atomicRow(atomic.id);
    expect(reverted.status).toBe("open");
    expect(reverted.contentPieceId).toBeNull();
  });

  it("refuses a published release, leaving the row and its atomic updates intact", async () => {
    const { release, atomic } = await seed("published");

    await expect(deleteDraft(formDataFor(release.id))).rejects.toThrow(/already been published/i);

    expect((await releaseRow(release.id)).status).toBe("published");
    const untouched = await atomicRow(atomic.id);
    expect(untouched.status).toBe("released");
    expect(untouched.contentPieceId).toBe(release.id);
  });

  // assertDraftEditable (which every other deleteDraft case in this file
  // exercises indirectly through the "draft"/"published" statuses seed()
  // produces) refuses "brief" outright. deleteDraft uses its own check
  // instead specifically so a "brief" piece — one whose generation can never
  // succeed, e.g. no linked brief or a persistent model failure — has a way
  // out rather than sitting forever, undeletable, inflating the sidebar count.
  it("deletes a \"brief\"-status piece, unlike assertDraftEditable's other callers", async () => {
    const { release, atomic } = await seed("draft");
    await db.update(contentPieces).set({ status: "brief" }).where(eq(contentPieces.id, release.id));

    await deleteDraft(formDataFor(release.id));

    expect(await releaseRow(release.id)).toBeUndefined();
    const reverted = await atomicRow(atomic.id);
    expect(reverted.status).toBe("open");
    expect(reverted.contentPieceId).toBeNull();
  });
});
