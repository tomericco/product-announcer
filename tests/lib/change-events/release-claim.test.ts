import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, atomicUpdates, contentPieces } from "../../../src/db/schema";
import {
  revertReleaseAtomicUpdates,
  getOpenAtomicUpdates,
  markReleaseAtomicUpdatesReleased,
  linkAtomicUpdatesToPiece,
} from "../../../src/lib/change-events/release-claim";
import { computeReleaseDelta } from "../../../src/lib/change-events/release-deltas";

const TENANT = "Release Claim Test Tenant";
const seed = async (tenantId: string, titles: string[]) => {
  const out = [];
  for (const t of titles) {
    const [a] = await db.insert(atomicUpdates).values({ tenantId, title: t, summary: "S" }).returning();
    out.push(a);
  }
  return out;
};

/**
 * Helper mirroring what the retired `claimReleaseFromAtomicUpdates` used to
 * do in one transaction: create the piece, then link the atomic updates to
 * it. Two round-trips instead of one, which is fine for test setup.
 */
async function seedReleaseWithAtomicUpdates(tenantId: string, atomicUpdateIds: string[], title = "R") {
  const [release] = await db.insert(contentPieces).values({ tenantId, title, body: "B" }).returning();
  await linkAtomicUpdatesToPiece({ tenantId, contentPieceId: release.id, atomicUpdateIds });
  return release;
}

describe("getOpenAtomicUpdates / markReleaseAtomicUpdatesReleased / revertReleaseAtomicUpdates", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("getOpenAtomicUpdates returns only open for the tenant", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["Open"]);
    await db.insert(atomicUpdates).values({ tenantId: t.id, title: "Released", summary: "S", status: "released" });
    const open = await getOpenAtomicUpdates(t.id);
    expect(open.map((a) => a.id)).toEqual([a1.id]);
  });

  it("getOpenAtomicUpdates excludes an open atomic update already linked to a draft release", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["Open, unclaimed"]);
    const [a2] = await seed(t.id, ["Open, but in a draft"]);
    await seedReleaseWithAtomicUpdates(t.id, [a2.id], "Draft");

    const open = await getOpenAtomicUpdates(t.id);
    expect(open.map((a) => a.id)).toEqual([a1.id]);
  });

  it("markReleaseAtomicUpdatesReleased flips a release's atomic updates to released", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1, a2] = await seed(t.id, ["A1", "A2"]);
    const r = await seedReleaseWithAtomicUpdates(t.id, [a1.id, a2.id]);

    const count = await markReleaseAtomicUpdatesReleased(r.id);
    expect(count).toBe(2);

    const rows = await db.select().from(atomicUpdates).where(eq(atomicUpdates.contentPieceId, r.id));
    expect(rows.every((a) => a.status === "released")).toBe(true);
  });

  it("revertReleaseAtomicUpdates reopens and clears contentPieceId", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["A1"]);
    const r = await seedReleaseWithAtomicUpdates(t.id, [a1.id]);
    expect(await revertReleaseAtomicUpdates(r.id)).toBe(1);
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, a1.id));
    expect(after.status).toBe("open");
    expect(after.contentPieceId).toBeNull();
  });
});

describe("linkAtomicUpdatesToPiece", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  async function seedPiece(tenantId: string) {
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId, title: "Existing piece", body: "B" })
      .returning();
    return piece;
  }

  it("links the atomic updates to the existing piece and leaves them open", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1, a2] = await seed(t.id, ["A1", "A2"]);
    const piece = await seedPiece(t.id);

    const linked = await linkAtomicUpdatesToPiece({
      tenantId: t.id,
      contentPieceId: piece.id,
      atomicUpdateIds: [a1.id, a2.id],
    });
    expect(linked).toBe(2);

    const rows = await db.select().from(atomicUpdates).where(eq(atomicUpdates.contentPieceId, piece.id));
    expect(rows).toHaveLength(2);
    // Open-until-publish, same as the claim: `markReleaseAtomicUpdatesReleased`
    // owns the transition to `released`. `contentPieceId` alone is what keeps
    // these out of the next compose run, so closing them here would buy nothing
    // and would strand the change events behind a merely-drafted piece.
    expect(rows.every((a) => a.status === "open")).toBe(true);
  });

  it("hands its links to the publish path, which is what closes them", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["A1"]);
    const piece = await seedPiece(t.id);

    await linkAtomicUpdatesToPiece({ tenantId: t.id, contentPieceId: piece.id, atomicUpdateIds: [a1.id] });
    // The end-to-end guarantee behind dropping the flip: an atomic update
    // linked by the drafting path must still reach `released` when its piece
    // publishes. `markReleaseAtomicUpdatesReleased` matches on contentPieceId
    // with no status predicate, so it closes these exactly as it closes a
    // claim-linked one.
    expect(await markReleaseAtomicUpdatesReleased(piece.id)).toBe(1);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, a1.id));
    expect(after.status).toBe("released");
  });

  it("creates no content piece", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["A1"]);
    const piece = await seedPiece(t.id);

    await linkAtomicUpdatesToPiece({ tenantId: t.id, contentPieceId: piece.id, atomicUpdateIds: [a1.id] });

    const pieces = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, t.id));
    expect(pieces).toHaveLength(1);
    expect(pieces[0].id).toBe(piece.id);
  });

  it("never links another tenant's atomic update", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [o] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [foreign] = await seed(o.id, ["F"]);
    const piece = await seedPiece(t.id);

    const linked = await linkAtomicUpdatesToPiece({
      tenantId: t.id,
      contentPieceId: piece.id,
      atomicUpdateIds: [foreign.id],
    });
    expect(linked).toBe(0);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreign.id));
    expect(after.status).toBe("open");
    expect(after.contentPieceId).toBeNull();
  });

  it("does not steal an atomic update another piece already claimed", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1, a2] = await seed(t.id, ["Already claimed", "Still open"]);
    const piece = await seedPiece(t.id);

    // A full generate + review round-trip separates the caller's derivation
    // of "open" ids from this write, so another concurrent linker (e.g. a
    // second drafting run, or catch-up's `linkNewAtomicUpdates`) winning that
    // race for a1 first is reachable, not hypothetical.
    const otherPiece = await seedPiece(t.id);
    const otherLinked = await linkAtomicUpdatesToPiece({
      tenantId: t.id,
      contentPieceId: otherPiece.id,
      atomicUpdateIds: [a1.id],
    });
    expect(otherLinked).toBe(1);

    const linked = await linkAtomicUpdatesToPiece({
      tenantId: t.id,
      contentPieceId: piece.id,
      atomicUpdateIds: [a1.id, a2.id],
    });
    // Drops rather than steals: the partial link is visible in the count.
    expect(linked).toBe(1);

    const [stolen] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, a1.id));
    expect(stolen.contentPieceId).toBe(otherPiece.id);
    expect(stolen.status).toBe("open");

    const [taken] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, a2.id));
    expect(taken.contentPieceId).toBe(piece.id);
    expect(taken.status).toBe("open");
  });

  it("does not relink an atomic update that is no longer open", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [released] = await db
      .insert(atomicUpdates)
      .values({ tenantId: t.id, title: "Shipped already", summary: "S", status: "released" })
      .returning();
    const piece = await seedPiece(t.id);

    expect(
      await linkAtomicUpdatesToPiece({
        tenantId: t.id,
        contentPieceId: piece.id,
        atomicUpdateIds: [released.id],
      })
    ).toBe(0);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, released.id));
    expect(after.contentPieceId).toBeNull();
  });

  it("does nothing on an empty id list", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["A1"]);
    const piece = await seedPiece(t.id);

    expect(
      await linkAtomicUpdatesToPiece({ tenantId: t.id, contentPieceId: piece.id, atomicUpdateIds: [] })
    ).toBe(0);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, a1.id));
    expect(after.contentPieceId).toBeNull();
  });

  it("stamps updatedAt with the caller's timestamp so composedAt can match it", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["A1"]);
    const piece = await seedPiece(t.id);

    // The caller writes the same Date to the piece's composedAt. Two
    // independent `new Date()` values would leave updatedAt a few ms later,
    // and computeReleaseDelta's strict `updatedAt > composedAt` would misread
    // the just-linked atomic update as a post-compose change.
    const at = new Date();
    await db.update(contentPieces).set({ composedAt: at }).where(eq(contentPieces.id, piece.id));
    await linkAtomicUpdatesToPiece({
      tenantId: t.id,
      contentPieceId: piece.id,
      atomicUpdateIds: [a1.id],
      at,
    });

    const delta = await computeReleaseDelta(piece.id);
    expect(delta.count).toBe(0);
  });

  it("participates in the caller's transaction", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["A1"]);
    const piece = await seedPiece(t.id);

    // The link must roll back with the body write it accompanies — a piece
    // saved with a body while its atomic updates stayed open would offer the
    // same shipped work to the next compose run.
    await expect(
      db.transaction(async (tx) => {
        await tx.update(contentPieces).set({ body: "Generated body" }).where(eq(contentPieces.id, piece.id));
        await linkAtomicUpdatesToPiece(
          { tenantId: t.id, contentPieceId: piece.id, atomicUpdateIds: [a1.id] },
          tx
        );
        throw new Error("save failed");
      })
    ).rejects.toThrow("save failed");

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, a1.id));
    expect(after.contentPieceId).toBeNull();
    expect(after.status).toBe("open");
    const [unchanged] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(unchanged.body).toBe("B");
  });
});
