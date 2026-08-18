import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, atomicUpdates, contentPieces } from "../../../src/db/schema";
import { catchUpRelease, startOverRelease } from "../../../src/lib/change-events/catch-up";
import { computeReleaseDelta } from "../../../src/lib/change-events/release-deltas";

const TENANT = "Catch-Up Test Tenant";

// Fixed baseline so before/after composedAt is deterministic instead of
// racing wall-clock `new Date()` (mirrors release-deltas.test.ts).
const T = new Date("2026-01-15T12:00:00Z");
const AFTER = new Date(T.getTime() + 1000);

describe("catchUpRelease", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("links the new atomic update, keeps it open, sets the merged body, and zeroes a subsequent delta", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "Old body", composedAt: T })
      .returning();
    const [newAu] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, title: "New thing", summary: "A new thing shipped.", createdAt: AFTER })
      .returning();

    const mergeDraft = vi.fn().mockResolvedValue({ title: "ignored", body: "Merged body" });

    const updated = await catchUpRelease(r.id, { mergeDraft });

    expect(updated).not.toBeNull();
    expect(updated!.body).toBe("Merged body");
    expect(updated!.composedAt.getTime()).toBeGreaterThan(T.getTime());

    const [linked] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, newAu.id));
    expect(linked.contentPieceId).toBe(r.id);
    expect(linked.status).toBe("open");

    // Advancing composedAt is what makes the catch-up count return to zero.
    const delta = await computeReleaseDelta(r.id);
    expect(delta.count).toBe(0);

    expect(mergeDraft).toHaveBeenCalledTimes(1);
    const call = mergeDraft.mock.calls[0][0];
    expect(call.currentBody).toBe("Old body");
    expect(call.newItems.map((i: { id: string }) => i.id)).toEqual([newAu.id]);
    expect(call.changedItems).toEqual([]);
  });

  it("includes an evidence-delta (changed) atomic update in the merge call without re-linking it", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "Old body", composedAt: T })
      .returning();
    const [changedAu] = await db
      .insert(atomicUpdates)
      .values({
        tenantId: t.id,
        contentPieceId: r.id,
        title: "Changed thing",
        summary: "Updated summary.",
        createdAt: new Date(T.getTime() - 1000),
        updatedAt: AFTER,
      })
      .returning();

    const mergeDraft = vi.fn().mockResolvedValue({ title: "ignored", body: "Merged body" });
    const updated = await catchUpRelease(r.id, { mergeDraft });

    expect(updated).not.toBeNull();
    const call = mergeDraft.mock.calls[0][0];
    expect(call.changedItems.map((i: { id: string }) => i.id)).toEqual([changedAu.id]);
    expect(call.newItems).toEqual([]);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, changedAu.id));
    expect(after.contentPieceId).toBe(r.id);
    expect(after.status).toBe("open");
  });

  it("never links another tenant's atomic update", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "Old body", composedAt: T })
      .returning();
    await db.insert(atomicUpdates).values({ tenantId: t.id, title: "Mine", summary: "S", createdAt: AFTER });
    const [foreignAu] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S", createdAt: AFTER })
      .returning();

    const mergeDraft = vi.fn().mockResolvedValue({ title: "ignored", body: "Merged body" });
    await catchUpRelease(r.id, { mergeDraft });

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreignAu.id));
    expect(after.contentPieceId).toBeNull();
    expect(after.status).toBe("open");
  });

  it("does not steal an atomic update that was already released/linked elsewhere before the delta read", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "Old body", composedAt: T })
      .returning();
    // Qualifies time-wise (created after composedAt) but is already spoken
    // for — simulates the "claimed/published between the delta read and the
    // link" race: it must never end up linked to this release.
    const [alreadyReleasedAu] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, title: "Already shipped", summary: "S", createdAt: AFTER, status: "released" })
      .returning();
    const [otherRelease] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "Other draft", body: "B", composedAt: T })
      .returning();
    const [alreadyLinkedAu] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, contentPieceId: otherRelease.id, title: "Claimed elsewhere", summary: "S", createdAt: AFTER })
      .returning();
    // Something must be a genuine new item, or count would be 0 and the
    // orchestrator would no-op before ever attempting to link anything.
    const [newAu] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, title: "Genuinely new", summary: "S", createdAt: AFTER })
      .returning();

    const mergeDraft = vi.fn().mockResolvedValue({ title: "ignored", body: "Merged body" });
    await catchUpRelease(r.id, { mergeDraft });

    const [releasedAfter] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, alreadyReleasedAu.id));
    expect(releasedAfter.status).toBe("released");
    expect(releasedAfter.contentPieceId).toBeNull();

    const [linkedAfter] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, alreadyLinkedAu.id));
    expect(linkedAfter.contentPieceId).toBe(otherRelease.id);

    const [newAfter] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, newAu.id));
    expect(newAfter.contentPieceId).toBe(r.id);
  });

  it("returns null and mutates nothing for a nonexistent contentPieceId", async () => {
    const mergeDraft = vi.fn();
    const result = await catchUpRelease("00000000-0000-0000-0000-000000000000", { mergeDraft });
    expect(result).toBeNull();
    expect(mergeDraft).not.toHaveBeenCalled();
  });

  it("returns null and mutates nothing when there is nothing to catch up on", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "Old body", composedAt: T })
      .returning();

    const mergeDraft = vi.fn();
    const result = await catchUpRelease(r.id, { mergeDraft });
    expect(result).toBeNull();
    expect(mergeDraft).not.toHaveBeenCalled();

    const [unchanged] = await db.select().from(contentPieces).where(eq(contentPieces.id, r.id));
    expect(unchanged.body).toBe("Old body");
  });
});

describe("catchUpRelease content-type gating", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("never lets a blog_post draft claim a tenant-wide unclaimed atomic update", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "Old body", type: "blog_post", composedAt: T })
      .returning();
    const [au] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, title: "Shipped work", summary: "S", createdAt: AFTER })
      .returning();

    const mergeDraft = vi.fn().mockResolvedValue({ title: "ignored", body: "Merged body" });
    const result = await catchUpRelease(r.id, { mergeDraft });

    // computeReleaseDelta resolves to the empty delta for a non-product_update
    // piece, so catchUpRelease no-ops exactly as it does for "nothing to catch
    // up on" — no merge call, no link, no body change.
    expect(result).toBeNull();
    expect(mergeDraft).not.toHaveBeenCalled();

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, au.id));
    expect(after.contentPieceId).toBeNull();
    expect(after.status).toBe("open");

    const [piece] = await db.select().from(contentPieces).where(eq(contentPieces.id, r.id));
    expect(piece.body).toBe("Old body");
  });

  it("still lets a product_update draft catch up exactly as before", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "Old body", type: "product_update", composedAt: T })
      .returning();
    const [au] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, title: "Shipped work", summary: "S", createdAt: AFTER })
      .returning();

    const mergeDraft = vi.fn().mockResolvedValue({ title: "ignored", body: "Merged body" });
    const result = await catchUpRelease(r.id, { mergeDraft });

    expect(result).not.toBeNull();
    expect(result!.body).toBe("Merged body");
    expect(mergeDraft).toHaveBeenCalledTimes(1);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, au.id));
    expect(after.contentPieceId).toBe(r.id);
    expect(after.status).toBe("open");
  });
});

describe("startOverRelease", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("links the new atomic update, regenerates from the FULL AU set, and zeroes a subsequent delta", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "Old body", composedAt: T })
      .returning();
    const [existing1] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, contentPieceId: r.id, title: "Existing 1", summary: "S1", createdAt: new Date(T.getTime() - 2000) })
      .returning();
    const [existing2] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, contentPieceId: r.id, title: "Existing 2", summary: "S2", createdAt: new Date(T.getTime() - 1000) })
      .returning();
    const [newAu] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, title: "New thing", summary: "A new thing shipped.", createdAt: AFTER })
      .returning();

    const generateDraft = vi.fn().mockResolvedValue({ title: "ignored", body: "From scratch body" });

    const updated = await startOverRelease(r.id, { generateDraft });

    expect(updated).not.toBeNull();
    expect(updated!.body).toBe("From scratch body");
    expect(updated!.composedAt.getTime()).toBeGreaterThan(T.getTime());

    const [linked] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, newAu.id));
    expect(linked.contentPieceId).toBe(r.id);
    expect(linked.status).toBe("open");

    const delta = await computeReleaseDelta(r.id);
    expect(delta.count).toBe(0);

    expect(generateDraft).toHaveBeenCalledTimes(1);
    const items = generateDraft.mock.calls[0][0] as { id: string }[];
    expect(new Set(items.map((i) => i.id))).toEqual(new Set([existing1.id, existing2.id, newAu.id]));
  });

  it("clears bodyEditedAt since the regenerated body carries no hand edits", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "Old body", composedAt: T, bodyEditedAt: T })
      .returning();
    await db.insert(atomicUpdates).values({ tenantId: t.id, title: "New thing", summary: "S", createdAt: AFTER });

    const generateDraft = vi.fn().mockResolvedValue({ title: "ignored", body: "From scratch body" });
    const updated = await startOverRelease(r.id, { generateDraft });

    expect(updated).not.toBeNull();
    expect(updated!.bodyEditedAt).toBeNull();
  });

  it("adopts the regenerated title instead of keeping the old one", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "Old title", body: "Old body", composedAt: T })
      .returning();
    await db.insert(atomicUpdates).values({ tenantId: t.id, title: "New thing", summary: "S", createdAt: AFTER });

    const generateDraft = vi.fn().mockResolvedValue({ title: "Fresh generated title", body: "From scratch body" });
    const updated = await startOverRelease(r.id, { generateDraft });

    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Fresh generated title");
  });

  it("does not steal an atomic update that was already released/linked elsewhere before the delta read", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "Old body", composedAt: T })
      .returning();
    // Qualifies time-wise (created after composedAt) but is already spoken
    // for — simulates the "claimed/published between the delta read and the
    // link" race: it must never end up linked to this release.
    const [alreadyReleasedAu] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, title: "Already shipped", summary: "S", createdAt: AFTER, status: "released" })
      .returning();
    const [otherRelease] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "Other draft", body: "B", composedAt: T })
      .returning();
    const [alreadyLinkedAu] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, contentPieceId: otherRelease.id, title: "Claimed elsewhere", summary: "S", createdAt: AFTER })
      .returning();
    // Something must be a genuine new item, or count would be 0 and the
    // orchestrator would no-op before ever attempting to link anything.
    const [newAu] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, title: "Genuinely new", summary: "S", createdAt: AFTER })
      .returning();

    const generateDraft = vi.fn().mockResolvedValue({ title: "ignored", body: "From scratch body" });
    await startOverRelease(r.id, { generateDraft });

    const [releasedAfter] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, alreadyReleasedAu.id));
    expect(releasedAfter.status).toBe("released");
    expect(releasedAfter.contentPieceId).toBeNull();

    const [linkedAfter] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, alreadyLinkedAu.id));
    expect(linkedAfter.contentPieceId).toBe(otherRelease.id);

    const [newAfter] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, newAu.id));
    expect(newAfter.contentPieceId).toBe(r.id);
  });

  it("never links another tenant's atomic update", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "Old body", composedAt: T })
      .returning();
    await db.insert(atomicUpdates).values({ tenantId: t.id, title: "Mine", summary: "S", createdAt: AFTER });
    const [foreignAu] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S", createdAt: AFTER })
      .returning();

    const generateDraft = vi.fn().mockResolvedValue({ title: "ignored", body: "From scratch body" });
    await startOverRelease(r.id, { generateDraft });

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreignAu.id));
    expect(after.contentPieceId).toBeNull();
  });

  it("returns null and mutates nothing for a nonexistent contentPieceId", async () => {
    const generateDraft = vi.fn();
    const result = await startOverRelease("00000000-0000-0000-0000-000000000000", { generateDraft });
    expect(result).toBeNull();
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it("returns null and mutates nothing when there is nothing to catch up on", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [r] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "R", body: "Old body", composedAt: T })
      .returning();
    await db.insert(atomicUpdates).values({
      tenantId: t.id,
      contentPieceId: r.id,
      title: "Existing",
      summary: "S",
      createdAt: new Date(T.getTime() - 1000),
      // Explicitly at (not after) composedAt — defaultNow() would otherwise
      // stamp real wall-clock time, which is after the fixed T baseline and
      // would spuriously register as an evidence-delta "changed" AU.
      updatedAt: T,
    });

    const generateDraft = vi.fn();
    const result = await startOverRelease(r.id, { generateDraft });
    expect(result).toBeNull();
    expect(generateDraft).not.toHaveBeenCalled();
  });
});
