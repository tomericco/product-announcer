import { describe, it, expect, vi, afterEach } from "vitest";
import { eq, like } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, atomicUpdates, users } from "../../../src/db/schema";
import { addEventsToExistingAtomicUpdate } from "../../../src/lib/change-events/add-events-to-atomic-update";

const TENANT = "Add Events To Atomic Update Test Tenant";
let USER: string;

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [repo] = await db
    .insert(repos)
    .values({
      tenantId: tenant.id,
      githubRepoFullName: "acme/widgets",
      githubInstallationId: "1",
      watchedBranch: "main",
    })
    .returning();
  const [user] = await db
    .insert(users)
    .values({ email: `add-events-test-user-${crypto.randomUUID()}@example.com` })
    .returning();
  USER = user.id;
  return { tenant, repo };
}

async function insertAtomic(
  tenantId: string,
  title: string,
  overrides: Partial<typeof atomicUpdates.$inferInsert> = {}
) {
  const [row] = await db
    .insert(atomicUpdates)
    .values({ tenantId, title, summary: "S", ...overrides })
    .returning();
  return row;
}

async function insertEvent(
  tenantId: string,
  repoId: string,
  externalId: string,
  overrides: Partial<typeof changeEvents.$inferInsert> = {}
) {
  const [row] = await db
    .insert(changeEvents)
    .values({
      tenantId,
      repoId,
      type: "commit",
      provider: "github",
      externalId,
      commitSha: externalId,
      commitMessage: `commit ${externalId}`,
      status: "pending",
      ...overrides,
    })
    .returning();
  return row;
}

describe("addEventsToExistingAtomicUpdate", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
    await db.delete(users).where(like(users.email, "add-events-test-user-%"));
  });

  it("adds multiple events to an existing open update and regenerates once", async () => {
    const { tenant, repo } = await seed();
    const target = await insertAtomic(tenant.id, "Target");
    const e1 = await insertEvent(tenant.id, repo.id, "sha-e1");
    const e2 = await insertEvent(tenant.id, repo.id, "sha-e2");
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await addEventsToExistingAtomicUpdate(
      { tenantId: tenant.id, userId: USER, atomicUpdateId: target.id, eventIds: [e1.id, e2.id] },
      { refresh }
    );

    expect(result.ok).toBe(true);
    const rows = await db.select().from(changeEvents).where(eq(changeEvents.atomicUpdateId, target.id));
    expect(rows.map((r) => r.id).sort()).toEqual([e1.id, e2.id].sort());
    // Regenerated once, over the target (and any surviving sources), not per-event.
    expect(refresh).toHaveBeenCalledTimes(1);
    const [, , ids] = refresh.mock.calls[0];
    expect(ids).toContain(target.id);
  });

  it("clears exclusion fields when pulling in an excluded event", async () => {
    const { tenant, repo } = await seed();
    const target = await insertAtomic(tenant.id, "Target");
    const event = await insertEvent(tenant.id, repo.id, "sha-excluded", {
      status: "excluded",
      excludedAt: new Date(),
      excludedBy: USER,
    });
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await addEventsToExistingAtomicUpdate(
      { tenantId: tenant.id, userId: USER, atomicUpdateId: target.id, eventIds: [event.id] },
      { refresh }
    );

    expect(result.ok).toBe(true);
    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).toBe(target.id);
    expect(updated.status).toBe("pending");
    expect(updated.excludedAt).toBeNull();
    expect(updated.excludedBy).toBeNull();
  });

  it("returns needsConfirmation naming every source that would be emptied, making no change until confirmed", async () => {
    const { tenant, repo } = await seed();
    const target = await insertAtomic(tenant.id, "Target");
    const sourceA = await insertAtomic(tenant.id, "Source A");
    const evA = await insertEvent(tenant.id, repo.id, "sha-source-a", { atomicUpdateId: sourceA.id }); // sole event of Source A
    const refresh = vi.fn();

    const pending = await addEventsToExistingAtomicUpdate(
      { tenantId: tenant.id, userId: USER, atomicUpdateId: target.id, eventIds: [evA.id] },
      { refresh }
    );
    expect(pending.ok).toBe(false);
    expect(pending).toMatchObject({
      needsConfirmation: true,
      emptiedAtomicUpdates: [{ id: sourceA.id, title: "Source A", inDraft: false }],
    });
    // No mutation yet.
    const [still] = await db.select().from(changeEvents).where(eq(changeEvents.id, evA.id));
    expect(still.atomicUpdateId).toBe(sourceA.id);
    expect(refresh).not.toHaveBeenCalled();

    const confirmed = await addEventsToExistingAtomicUpdate(
      { tenantId: tenant.id, userId: USER, atomicUpdateId: target.id, eventIds: [evA.id], confirmEmptyDeletion: true },
      { refresh }
    );
    expect(confirmed.ok).toBe(true);

    const [gone] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, sourceA.id));
    expect(gone).toBeUndefined();
  });

  it("keeps and refreshes a partially-emptied source that still has other events", async () => {
    const { tenant, repo } = await seed();
    const target = await insertAtomic(tenant.id, "Target");
    const survivingSource = await insertAtomic(tenant.id, "Partially emptied source");
    const eventToMove = await insertEvent(tenant.id, repo.id, "sha-surviving-move", {
      atomicUpdateId: survivingSource.id,
    });
    const eventKeptBehind = await insertEvent(tenant.id, repo.id, "sha-kept-behind", {
      atomicUpdateId: survivingSource.id,
    });
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await addEventsToExistingAtomicUpdate(
      { tenantId: tenant.id, userId: USER, atomicUpdateId: target.id, eventIds: [eventToMove.id] },
      { refresh }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.deletedAtomicUpdates ?? []).toEqual([]);

    const [moved] = await db.select().from(changeEvents).where(eq(changeEvents.id, eventToMove.id));
    expect(moved.atomicUpdateId).toBe(target.id);
    const [keptBehindRow] = await db.select().from(changeEvents).where(eq(changeEvents.id, eventKeptBehind.id));
    expect(keptBehindRow.atomicUpdateId).toBe(survivingSource.id);

    const [stillSurvives] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, survivingSource.id));
    expect(stillSurvives).toBeDefined();

    expect(refresh).toHaveBeenCalledTimes(1);
    const [, , ids] = refresh.mock.calls[0];
    expect(new Set(ids)).toEqual(new Set([target.id, survivingSource.id]));
  });

  it("rejects adding to a target that is not open (released) or not found", async () => {
    const { tenant, repo } = await seed();
    const released = await insertAtomic(tenant.id, "Shipped", { status: "released" });
    const e1 = await insertEvent(tenant.id, repo.id, "sha-e1-released-target");
    const res = await addEventsToExistingAtomicUpdate(
      { tenantId: tenant.id, userId: USER, atomicUpdateId: released.id, eventIds: [e1.id] },
      { refresh: vi.fn() }
    );
    expect(res.ok).toBe(false);

    const missing = await addEventsToExistingAtomicUpdate(
      {
        tenantId: tenant.id,
        userId: USER,
        atomicUpdateId: "00000000-0000-0000-0000-000000000099",
        eventIds: [e1.id],
      },
      { refresh: vi.fn() }
    );
    expect(missing.ok).toBe(false);
  });

  it("rejects a target owned by another tenant", async () => {
    const { tenant, repo } = await seed();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const foreignTarget = await insertAtomic(other.id, "Foreign target");
    const event = await insertEvent(tenant.id, repo.id, "sha-cross-tenant-target");

    const result = await addEventsToExistingAtomicUpdate(
      { tenantId: tenant.id, userId: USER, atomicUpdateId: foreignTarget.id, eventIds: [event.id] },
      { refresh: vi.fn() }
    );

    expect(result.ok).toBe(false);
    const [unchanged] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(unchanged.atomicUpdateId).toBeNull();
  });

  it("rejects the whole batch when a selected event's source AU is released, and mutates nothing", async () => {
    const { tenant, repo } = await seed();
    const target = await insertAtomic(tenant.id, "Target");
    const released = await insertAtomic(tenant.id, "Shipped", { status: "released" });
    const releasedEvent = await insertEvent(tenant.id, repo.id, "sha-released-source", {
      atomicUpdateId: released.id,
    });
    const refresh = vi.fn();

    const result = await addEventsToExistingAtomicUpdate(
      { tenantId: tenant.id, userId: USER, atomicUpdateId: target.id, eventIds: [releasedEvent.id] },
      { refresh }
    );

    expect(result.ok).toBe(false);
    const [unchanged] = await db.select().from(changeEvents).where(eq(changeEvents.id, releasedEvent.id));
    expect(unchanged.atomicUpdateId).toBe(released.id);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects an empty eventIds array and mutates nothing", async () => {
    const { tenant } = await seed();
    const target = await insertAtomic(tenant.id, "Target");
    const refresh = vi.fn();

    const result = await addEventsToExistingAtomicUpdate(
      { tenantId: tenant.id, userId: USER, atomicUpdateId: target.id, eventIds: [] },
      { refresh }
    );

    expect(result.ok).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects a nonexistent or cross-tenant event id and mutates nothing", async () => {
    const { tenant, repo } = await seed();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [otherRepo] = await db
      .insert(repos)
      .values({
        tenantId: other.id,
        githubRepoFullName: "acme/other",
        githubInstallationId: "2",
        watchedBranch: "main",
      })
      .returning();
    const target = await insertAtomic(tenant.id, "Target");
    const event = await insertEvent(tenant.id, repo.id, "sha-own-add");
    const foreign = await insertEvent(other.id, otherRepo.id, "sha-foreign-add");
    const refresh = vi.fn();

    const result = await addEventsToExistingAtomicUpdate(
      { tenantId: tenant.id, userId: USER, atomicUpdateId: target.id, eventIds: [event.id, foreign.id] },
      { refresh }
    );

    expect(result.ok).toBe(false);
    const [unchangedOwn] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    const [unchangedForeign] = await db.select().from(changeEvents).where(eq(changeEvents.id, foreign.id));
    expect(unchangedOwn.atomicUpdateId).toBeNull();
    expect(unchangedForeign.atomicUpdateId).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("clears summaryEditedAt on the target so a hand-edit no longer freezes it", async () => {
    const { tenant, repo } = await seed();
    const target = await insertAtomic(tenant.id, "Target", { summaryEditedAt: new Date() });
    const event = await insertEvent(tenant.id, repo.id, "sha-force-regen");
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await addEventsToExistingAtomicUpdate(
      { tenantId: tenant.id, userId: USER, atomicUpdateId: target.id, eventIds: [event.id] },
      { refresh }
    );

    expect(result.ok).toBe(true);
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, target.id));
    expect(after.summaryEditedAt).toBeNull();
  });

  it("still succeeds even when the best-effort refresh throws", async () => {
    const { tenant, repo } = await seed();
    const target = await insertAtomic(tenant.id, "Target");
    const event = await insertEvent(tenant.id, repo.id, "sha-refresh-throws");
    const refresh = vi.fn().mockRejectedValue(new Error("boom"));

    const result = await addEventsToExistingAtomicUpdate(
      { tenantId: tenant.id, userId: USER, atomicUpdateId: target.id, eventIds: [event.id] },
      { refresh }
    );

    expect(result.ok).toBe(true);
    const [moved] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(moved.atomicUpdateId).toBe(target.id);
  });
});
