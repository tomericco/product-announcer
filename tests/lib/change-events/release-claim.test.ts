import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, atomicUpdates, releases } from "../../../src/db/schema";
import {
  claimReleaseFromAtomicUpdates,
  revertReleaseAtomicUpdates,
  getOpenAtomicUpdates,
  markReleaseAtomicUpdatesReleased,
} from "../../../src/lib/change-events/release-claim";

const TENANT = "Release Claim Test Tenant";
const seed = async (tenantId: string, titles: string[]) => {
  const out = [];
  for (const t of titles) {
    const [a] = await db.insert(atomicUpdates).values({ tenantId, title: t, summary: "S" }).returning();
    out.push(a);
  }
  return out;
};

describe("claimReleaseFromAtomicUpdates", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("links selected atomic updates to the release but leaves them open until publish", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1, a2] = await seed(t.id, ["A1", "A2"]);
    const r = await claimReleaseFromAtomicUpdates({
      tenantId: t.id,
      atomicUpdateIds: [a1.id, a2.id],
      draft: { title: "R", body: "B" },
      review: { status: "passed", issues: [] },
    });
    expect(r).not.toBeNull();
    const claimed = await db.select().from(atomicUpdates).where(eq(atomicUpdates.releaseId, r!.id));
    expect(claimed).toHaveLength(2);
    // Atomic updates stay `open` while their release is a draft — only
    // publishing (markReleaseAtomicUpdatesReleased) flips them to `released`.
    expect(claimed.every((a) => a.status === "open")).toBe(true);
  });

  it("does not re-claim an atomic update that is already linked to an (open) draft release", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["A1"]);
    const first = await claimReleaseFromAtomicUpdates({
      tenantId: t.id,
      atomicUpdateIds: [a1.id],
      draft: { title: "First", body: "B" },
    });
    expect(first).not.toBeNull();

    // a1 is now open AND releaseId-linked — exclusivity must key off releaseId,
    // not status, since status is still 'open'.
    const second = await claimReleaseFromAtomicUpdates({
      tenantId: t.id,
      atomicUpdateIds: [a1.id],
      draft: { title: "Second (should not persist)", body: "B" },
    });
    expect(second).toBeNull();

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, a1.id));
    expect(after.releaseId).toBe(first!.id);
  });

  it("returns null when none of the ids are open", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["A1"]);
    await claimReleaseFromAtomicUpdates({
      tenantId: t.id,
      atomicUpdateIds: [a1.id],
      draft: { title: "R1", body: "B" },
    });
    const second = await claimReleaseFromAtomicUpdates({
      tenantId: t.id,
      atomicUpdateIds: [a1.id],
      draft: { title: "R2", body: "B" },
    });
    expect(second).toBeNull();
  });

  it("never claims another tenant's atomic update", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [o] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [foreign] = await seed(o.id, ["F"]);
    const r = await claimReleaseFromAtomicUpdates({
      tenantId: t.id,
      atomicUpdateIds: [foreign.id],
      draft: { title: "R", body: "B" },
    });
    expect(r).toBeNull();
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreign.id));
    expect(after.status).toBe("open");
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
    await claimReleaseFromAtomicUpdates({
      tenantId: t.id,
      atomicUpdateIds: [a2.id],
      draft: { title: "Draft", body: "B" },
    });

    const open = await getOpenAtomicUpdates(t.id);
    expect(open.map((a) => a.id)).toEqual([a1.id]);
  });

  it("markReleaseAtomicUpdatesReleased flips a release's atomic updates to released", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1, a2] = await seed(t.id, ["A1", "A2"]);
    const r = await claimReleaseFromAtomicUpdates({
      tenantId: t.id,
      atomicUpdateIds: [a1.id, a2.id],
      draft: { title: "R", body: "B" },
    });
    expect(r).not.toBeNull();

    const count = await markReleaseAtomicUpdatesReleased(r!.id);
    expect(count).toBe(2);

    const rows = await db.select().from(atomicUpdates).where(eq(atomicUpdates.releaseId, r!.id));
    expect(rows.every((a) => a.status === "released")).toBe(true);
  });

  it("revertReleaseAtomicUpdates reopens and clears releaseId", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["A1"]);
    const r = await claimReleaseFromAtomicUpdates({
      tenantId: t.id,
      atomicUpdateIds: [a1.id],
      draft: { title: "R", body: "B" },
    });
    expect(await revertReleaseAtomicUpdates(r!.id)).toBe(1);
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, a1.id));
    expect(after.status).toBe("open");
    expect(after.releaseId).toBeNull();
  });

  it("rolls back the release insert when the claim is empty (no orphan draft survives)", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["A1"]);
    // Claim it once so it's no longer open.
    await claimReleaseFromAtomicUpdates({
      tenantId: t.id,
      atomicUpdateIds: [a1.id],
      draft: { title: "First", body: "B" },
    });

    const before = await db.select().from(releases).where(eq(releases.tenantId, t.id));

    const second = await claimReleaseFromAtomicUpdates({
      tenantId: t.id,
      atomicUpdateIds: [a1.id],
      draft: { title: "Second (should not persist)", body: "B" },
    });
    expect(second).toBeNull();

    const after = await db.select().from(releases).where(eq(releases.tenantId, t.id));
    expect(after).toHaveLength(before.length);
    expect(after.some((r) => r.title === "Second (should not persist)")).toBe(false);
  });
});
