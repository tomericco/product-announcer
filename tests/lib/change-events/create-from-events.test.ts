import { describe, it, expect, vi, afterEach } from "vitest";
import { eq, like } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, atomicUpdates, releases, users } from "../../../src/db/schema";
import { createAtomicUpdateFromEvents } from "../../../src/lib/change-events/create-from-events";

const TENANT = "Create From Events Test Tenant";
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
    .values({ email: `create-from-events-test-user-${crypto.randomUUID()}@example.com` })
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

describe("createAtomicUpdateFromEvents", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
    await db.delete(users).where(like(users.email, "create-from-events-test-user-%"));
  });

  it("creates one new open AU from 2 unassigned events and links both", async () => {
    const { tenant, repo } = await seed();
    const eventA = await insertEvent(tenant.id, repo.id, "sha-a", {
      prTitle: "Add CSV export",
      impactSummary: "Users can export data as CSV.",
      suggestedCategory: "new",
    });
    const eventB = await insertEvent(tenant.id, repo.id, "sha-b");
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await createAtomicUpdateFromEvents(
      { tenantId: tenant.id, userId: USER, eventIds: [eventA.id, eventB.id] },
      { refresh }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.atomicUpdateId).toBeTruthy();
    expect(result.deletedAtomicUpdates ?? []).toEqual([]);

    const [createdAtomic] = await db
      .select()
      .from(atomicUpdates)
      .where(eq(atomicUpdates.id, result.atomicUpdateId));
    expect(createdAtomic.status).toBe("open");
    expect(createdAtomic.title).toBe("Add CSV export");
    expect(createdAtomic.summary).toBe("Users can export data as CSV.");
    expect(createdAtomic.category).toBe("new");
    expect(createdAtomic.tenantId).toBe(tenant.id);

    const [updatedA] = await db.select().from(changeEvents).where(eq(changeEvents.id, eventA.id));
    const [updatedB] = await db.select().from(changeEvents).where(eq(changeEvents.id, eventB.id));
    expect(updatedA.atomicUpdateId).toBe(result.atomicUpdateId);
    expect(updatedA.status).toBe("pending");
    expect(updatedB.atomicUpdateId).toBe(result.atomicUpdateId);
    expect(updatedB.status).toBe("pending");

    expect(refresh).toHaveBeenCalledTimes(1);
    const [, , ids] = refresh.mock.calls[0];
    expect(ids).toContain(result.atomicUpdateId);
  });

  it("seeds title/summary/category from the event at eventIds[0], not physical SQL row order", async () => {
    // `events` is fetched via `inArray(changeEvents.id, requestedIds)` with NO
    // `ORDER BY`, so SQL row order is not guaranteed to match `eventIds`
    // order. The contract is "seeded from the first selected event" =
    // `eventIds[0]`. We insert "FIRST-CHOSEN" before "SECOND" (so a naive
    // `events[0]` read of insertion/heap order — which Postgres tends to
    // preserve for a simple `inArray` — would pick "SECOND" up first), then
    // pass `eventIds` in the OPPOSITE order (SECOND's id first is wrong;
    // FIRST-CHOSEN's id must be first). This pins input-order semantics
    // regardless of what SQL row order actually comes back.
    const { tenant, repo } = await seed();
    const eventSecondInserted = await insertEvent(tenant.id, repo.id, "sha-second-inserted", {
      prTitle: "SECOND",
      impactSummary: "Second summary.",
      suggestedCategory: "improvement",
    });
    const eventFirstChosen = await insertEvent(tenant.id, repo.id, "sha-first-chosen", {
      prTitle: "FIRST-CHOSEN",
      impactSummary: "First summary.",
      suggestedCategory: "new",
    });
    const refresh = vi.fn().mockResolvedValue(undefined);

    // eventFirstChosen was inserted SECOND (after eventSecondInserted), so if
    // SQL returns rows in insertion order, `events[0]` would be
    // eventSecondInserted — but eventIds[0] here is eventFirstChosen's id.
    const result = await createAtomicUpdateFromEvents(
      { tenantId: tenant.id, userId: USER, eventIds: [eventFirstChosen.id, eventSecondInserted.id] },
      { refresh }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    const [createdAtomic] = await db
      .select()
      .from(atomicUpdates)
      .where(eq(atomicUpdates.id, result.atomicUpdateId));
    expect(createdAtomic.title).toBe("FIRST-CHOSEN");
    expect(createdAtomic.summary).toBe("First summary.");
    expect(createdAtomic.category).toBe("new");
  });

  it("clears exclusion fields when pulling in an excluded event", async () => {
    const { tenant, repo } = await seed();
    const event = await insertEvent(tenant.id, repo.id, "sha-excluded", {
      status: "excluded",
      excludedAt: new Date(),
      excludedBy: USER,
    });
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await createAtomicUpdateFromEvents(
      { tenantId: tenant.id, userId: USER, eventIds: [event.id] },
      { refresh }
    );

    expect(result.ok).toBe(true);
    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.status).toBe("pending");
    expect(updated.excludedAt).toBeNull();
    expect(updated.excludedBy).toBeNull();
  });

  describe("emptying source AUs across a batch", () => {
    it("unconfirmed: needs_confirmation lists the fully-emptied source AU and performs no mutation", async () => {
      const { tenant, repo } = await seed();
      const emptiedSource = await insertAtomic(tenant.id, "Fully emptied source");
      const survivingSource = await insertAtomic(tenant.id, "Partially emptied source");
      const eventFromEmptied = await insertEvent(tenant.id, repo.id, "sha-emptied", {
        atomicUpdateId: emptiedSource.id,
      });
      const eventFromSurviving = await insertEvent(tenant.id, repo.id, "sha-surviving-move", {
        atomicUpdateId: survivingSource.id,
      });
      const eventKeptBehind = await insertEvent(tenant.id, repo.id, "sha-kept-behind", {
        atomicUpdateId: survivingSource.id,
      });
      const refresh = vi.fn().mockResolvedValue(undefined);

      const result = await createAtomicUpdateFromEvents(
        {
          tenantId: tenant.id,
          userId: USER,
          eventIds: [eventFromEmptied.id, eventFromSurviving.id],
        },
        { refresh }
      );

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({
        reason: "needs_confirmation",
        needsConfirmation: true,
      });
      if (result.ok || !("needsConfirmation" in result) || !result.needsConfirmation) throw new Error("expected needs_confirmation");
      expect(result.emptiedAtomicUpdates).toEqual([
        { id: emptiedSource.id, title: "Fully emptied source", inDraft: false },
      ]);

      // No mutation: events unmoved, both AUs intact.
      const [unchangedEmptied] = await db.select().from(changeEvents).where(eq(changeEvents.id, eventFromEmptied.id));
      const [unchangedSurviving] = await db
        .select()
        .from(changeEvents)
        .where(eq(changeEvents.id, eventFromSurviving.id));
      expect(unchangedEmptied.atomicUpdateId).toBe(emptiedSource.id);
      expect(unchangedSurviving.atomicUpdateId).toBe(survivingSource.id);

      const [emptiedStillThere] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, emptiedSource.id));
      const [survivingStillThere] = await db
        .select()
        .from(atomicUpdates)
        .where(eq(atomicUpdates.id, survivingSource.id));
      expect(emptiedStillThere).toBeDefined();
      expect(survivingStillThere).toBeDefined();

      expect(refresh).not.toHaveBeenCalled();
      void eventKeptBehind;
    });

    it("confirmed: creates the new AU, moves the events, deletes the emptied source, keeps+refreshes the surviving source", async () => {
      const { tenant, repo } = await seed();
      const emptiedSource = await insertAtomic(tenant.id, "Fully emptied source");
      const survivingSource = await insertAtomic(tenant.id, "Partially emptied source");
      const eventFromEmptied = await insertEvent(tenant.id, repo.id, "sha-emptied-2", {
        atomicUpdateId: emptiedSource.id,
      });
      const eventFromSurviving = await insertEvent(tenant.id, repo.id, "sha-surviving-move-2", {
        atomicUpdateId: survivingSource.id,
      });
      const eventKeptBehind = await insertEvent(tenant.id, repo.id, "sha-kept-behind-2", {
        atomicUpdateId: survivingSource.id,
      });
      const refresh = vi.fn().mockResolvedValue(undefined);

      const result = await createAtomicUpdateFromEvents(
        {
          tenantId: tenant.id,
          userId: USER,
          eventIds: [eventFromEmptied.id, eventFromSurviving.id],
          confirmEmptyDeletion: true,
        },
        { refresh }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.deletedAtomicUpdates).toEqual([{ id: emptiedSource.id, title: "Fully emptied source" }]);

      const [movedEmptied] = await db.select().from(changeEvents).where(eq(changeEvents.id, eventFromEmptied.id));
      const [movedSurviving] = await db
        .select()
        .from(changeEvents)
        .where(eq(changeEvents.id, eventFromSurviving.id));
      expect(movedEmptied.atomicUpdateId).toBe(result.atomicUpdateId);
      expect(movedSurviving.atomicUpdateId).toBe(result.atomicUpdateId);

      const [gone] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, emptiedSource.id));
      expect(gone).toBeUndefined();

      const [stillSurvives] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, survivingSource.id));
      expect(stillSurvives).toBeDefined();

      const [keptBehindRow] = await db
        .select()
        .from(changeEvents)
        .where(eq(changeEvents.id, eventKeptBehind.id));
      expect(keptBehindRow.atomicUpdateId).toBe(survivingSource.id);

      expect(refresh).toHaveBeenCalledTimes(1);
      const [, , ids] = refresh.mock.calls[0];
      expect(new Set(ids)).toEqual(new Set([result.atomicUpdateId, survivingSource.id]));
    });

    it("inDraft is true when the emptied source AU has a releaseId", async () => {
      const { tenant, repo } = await seed();
      const [release] = await db
        .insert(releases)
        .values({ tenantId: tenant.id, title: "Draft", body: "B" })
        .returning();
      const emptiedSource = await insertAtomic(tenant.id, "In draft source", { releaseId: release.id });
      const event = await insertEvent(tenant.id, repo.id, "sha-in-draft", { atomicUpdateId: emptiedSource.id });
      const refresh = vi.fn().mockResolvedValue(undefined);

      const result = await createAtomicUpdateFromEvents(
        { tenantId: tenant.id, userId: USER, eventIds: [event.id] },
        { refresh }
      );

      expect(result.ok).toBe(false);
      if (result.ok || !("needsConfirmation" in result) || !result.needsConfirmation) throw new Error("expected needs_confirmation");
      expect(result.emptiedAtomicUpdates).toEqual([{ id: emptiedSource.id, title: "In draft source", inDraft: true }]);
    });
  });

  it("rejects the whole batch when a selected event's source AU is released, and mutates nothing", async () => {
    const { tenant, repo } = await seed();
    const released = await insertAtomic(tenant.id, "Shipped", { status: "released" });
    const openOne = await insertAtomic(tenant.id, "Open one");
    const releasedEvent = await insertEvent(tenant.id, repo.id, "sha-released-source", {
      atomicUpdateId: released.id,
    });
    const openEvent = await insertEvent(tenant.id, repo.id, "sha-open-source", { atomicUpdateId: openOne.id });
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await createAtomicUpdateFromEvents(
      { tenantId: tenant.id, userId: USER, eventIds: [releasedEvent.id, openEvent.id] },
      { refresh }
    );

    expect(result.ok).toBe(false);
    const [unchangedReleased] = await db.select().from(changeEvents).where(eq(changeEvents.id, releasedEvent.id));
    const [unchangedOpen] = await db.select().from(changeEvents).where(eq(changeEvents.id, openEvent.id));
    expect(unchangedReleased.atomicUpdateId).toBe(released.id);
    expect(unchangedOpen.atomicUpdateId).toBe(openOne.id);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects a batch containing a cross-tenant event id and mutates nothing", async () => {
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
    const event = await insertEvent(tenant.id, repo.id, "sha-own");
    const foreign = await insertEvent(other.id, otherRepo.id, "sha-foreign");
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await createAtomicUpdateFromEvents(
      { tenantId: tenant.id, userId: USER, eventIds: [event.id, foreign.id] },
      { refresh }
    );

    expect(result.ok).toBe(false);
    const [unchangedOwn] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    const [unchangedForeign] = await db.select().from(changeEvents).where(eq(changeEvents.id, foreign.id));
    expect(unchangedOwn.atomicUpdateId).toBeNull();
    expect(unchangedForeign.atomicUpdateId).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects an empty eventIds array and mutates nothing", async () => {
    const { tenant } = await seed();
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await createAtomicUpdateFromEvents({ tenantId: tenant.id, userId: USER, eventIds: [] }, { refresh });

    expect(result.ok).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects a nonexistent event id and mutates nothing", async () => {
    const { tenant, repo } = await seed();
    const event = await insertEvent(tenant.id, repo.id, "sha-real");
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await createAtomicUpdateFromEvents(
      { tenantId: tenant.id, userId: USER, eventIds: [event.id, "00000000-0000-0000-0000-000000000099"] },
      { refresh }
    );

    expect(result.ok).toBe(false);
    const [unchanged] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(unchanged.atomicUpdateId).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  describe("deterministic updatedAt bump", () => {
    it("sets the new AU's updatedAt and bumps a surviving in-draft source AU's updatedAt", async () => {
      const { tenant, repo } = await seed();
      const composedAt = new Date(Date.now() - 60_000);
      const [release] = await db
        .insert(releases)
        .values({ tenantId: tenant.id, title: "Draft", body: "B", composedAt })
        .returning();
      const survivingSource = await insertAtomic(tenant.id, "In-draft surviving source", {
        releaseId: release.id,
        updatedAt: composedAt,
      });
      const eventToMove = await insertEvent(tenant.id, repo.id, "sha-move-from-draft", {
        atomicUpdateId: survivingSource.id,
      });
      const eventKeptBehind = await insertEvent(tenant.id, repo.id, "sha-kept-behind-draft", {
        atomicUpdateId: survivingSource.id,
      });
      const refresh = vi.fn().mockResolvedValue(undefined);

      const before = Date.now();
      const result = await createAtomicUpdateFromEvents(
        { tenantId: tenant.id, userId: USER, eventIds: [eventToMove.id] },
        { refresh }
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");

      const [createdAtomic] = await db
        .select()
        .from(atomicUpdates)
        .where(eq(atomicUpdates.id, result.atomicUpdateId));
      expect(createdAtomic.updatedAt).not.toBeNull();
      expect(createdAtomic.updatedAt!.getTime()).toBeGreaterThanOrEqual(before);

      const [bumpedSource] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, survivingSource.id));
      expect(bumpedSource.updatedAt.getTime()).toBeGreaterThan(composedAt.getTime());

      void eventKeptBehind;
    });
  });
});
