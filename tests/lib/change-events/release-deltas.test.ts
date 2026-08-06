import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, atomicUpdates, contentPieces } from "../../../src/db/schema";
import { computeReleaseDelta } from "../../../src/lib/change-events/release-deltas";

const TENANT = "Release Deltas Test Tenant";

// Fixed baseline so before/after composedAt is deterministic instead of
// racing wall-clock `new Date()`.
const T = new Date("2026-01-15T12:00:00Z");
const BEFORE = new Date(T.getTime() - 1000);
const AFTER = new Date(T.getTime() + 1000);

describe("computeReleaseDelta", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("includes an open, unlinked AU created after composedAt in newAtomicUpdates", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "B", composedAt: T })
      .returning();
    const [au] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, title: "New", summary: "S", createdAt: AFTER })
      .returning();

    const delta = await computeReleaseDelta(r.id);
    expect(delta.newAtomicUpdates.map((a) => a.id)).toEqual([au.id]);
  });

  it("excludes an open, unlinked AU created before composedAt from newAtomicUpdates", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "B", composedAt: T })
      .returning();
    await db.insert(atomicUpdates).values({ tenantId: t.id, title: "Old", summary: "S", createdAt: BEFORE });

    const delta = await computeReleaseDelta(r.id);
    expect(delta.newAtomicUpdates).toEqual([]);
  });

  it("includes an AU linked to this release with updatedAt > composedAt in changedAtomicUpdates", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "B", composedAt: T })
      .returning();
    const [au] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, contentPieceId: r.id, title: "Changed", summary: "S", createdAt: BEFORE, updatedAt: AFTER })
      .returning();

    const delta = await computeReleaseDelta(r.id);
    expect(delta.changedAtomicUpdates.map((a) => a.id)).toEqual([au.id]);
  });

  it("excludes an AU linked to this release with updatedAt <= composedAt from changedAtomicUpdates", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "B", composedAt: T })
      .returning();
    await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, contentPieceId: r.id, title: "Unchanged", summary: "S", createdAt: BEFORE, updatedAt: T });

    const delta = await computeReleaseDelta(r.id);
    expect(delta.changedAtomicUpdates).toEqual([]);
  });

  it("count equals the sum of both lists", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "B", composedAt: T })
      .returning();
    await db.insert(atomicUpdates).values({ tenantId: t.id, title: "New1", summary: "S", createdAt: AFTER });
    await db.insert(atomicUpdates).values({ tenantId: t.id, title: "New2", summary: "S", createdAt: AFTER });
    await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, contentPieceId: r.id, title: "Changed", summary: "S", createdAt: BEFORE, updatedAt: AFTER });

    const delta = await computeReleaseDelta(r.id);
    expect(delta.newAtomicUpdates).toHaveLength(2);
    expect(delta.changedAtomicUpdates).toHaveLength(1);
    expect(delta.count).toBe(3);
  });

  it("does not leak another tenant's new atomic update", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "B", composedAt: T })
      .returning();
    await db.insert(atomicUpdates).values({ tenantId: other.id, title: "Foreign New", summary: "S", createdAt: AFTER });

    const delta = await computeReleaseDelta(r.id);
    expect(delta.newAtomicUpdates).toEqual([]);
    expect(delta.count).toBe(0);
  });

  it("returns the empty delta without throwing for a nonexistent contentPieceId", async () => {
    const delta = await computeReleaseDelta("00000000-0000-0000-0000-000000000000");
    expect(delta).toEqual({ newAtomicUpdates: [], changedAtomicUpdates: [], count: 0 });
  });

  it("reports no catch-up deltas for a blog_post piece, even with a qualifying tenant-wide atomic update", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "B", type: "blog_post", composedAt: T })
      .returning();
    // Would otherwise qualify as a membership-delta new atomic update — the
    // whole point of this test is that a non-product_update piece must never
    // see it, since `newAtomicUpdates` is tenant-wide, not scoped to this piece.
    await db.insert(atomicUpdates).values({ tenantId: t.id, title: "Shipped work", summary: "S", createdAt: AFTER });

    const delta = await computeReleaseDelta(r.id);
    expect(delta).toEqual({ newAtomicUpdates: [], changedAtomicUpdates: [], count: 0 });
  });

  it("still computes real deltas for a product_update piece", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "B", type: "product_update", composedAt: T })
      .returning();
    const [au] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, title: "Shipped work", summary: "S", createdAt: AFTER })
      .returning();

    const delta = await computeReleaseDelta(r.id);
    expect(delta.newAtomicUpdates.map((a) => a.id)).toEqual([au.id]);
    expect(delta.count).toBe(1);
  });
});
