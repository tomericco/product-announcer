import { describe, it, expect, vi, afterEach } from "vitest";
import { eq, like } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, atomicUpdates, releases, users } from "../../../src/db/schema";
import { reassignChangeEvent, openAtomicUpdatesForReassign } from "../../../src/lib/change-events/reassign";
import { computeReleaseDelta } from "../../../src/lib/change-events/release-deltas";

const TENANT = "Reassign Test Tenant";
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
    .values({ email: `reassign-test-user-${crypto.randomUUID()}@example.com` })
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

describe("reassignChangeEvent", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
    await db.delete(users).where(like(users.email, "reassign-test-user-%"));
  });

  it("moves an event to an existing open atomic update and clears exclusion", async () => {
    const { tenant, repo } = await seed();
    const source = await insertAtomic(tenant.id, "Source");
    const target = await insertAtomic(tenant.id, "Target");
    const other = await insertEvent(tenant.id, repo.id, "sha-other", { atomicUpdateId: source.id });
    const event = await insertEvent(tenant.id, repo.id, "sha-move", {
      atomicUpdateId: source.id,
      status: "excluded",
      excludedAt: new Date(),
      excludedBy: USER,
    });
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await reassignChangeEvent(
      { tenantId: tenant.id, userId: USER, eventId: event.id, target: { kind: "existing", atomicUpdateId: target.id } },
      { refresh }
    );

    expect(result).toEqual({ ok: true });

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).toBe(target.id);
    expect(updated.status).toBe("pending");
    expect(updated.excludedAt).toBeNull();
    expect(updated.excludedBy).toBeNull();

    // Source AU still has `other`, so it survives.
    const [survivingSource] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, source.id));
    expect(survivingSource).toBeDefined();

    expect(refresh).toHaveBeenCalledTimes(1);
    const [, , ids] = refresh.mock.calls[0];
    expect(new Set(ids)).toEqual(new Set([target.id, source.id]));

    void other;
  });

  it("deletes the source atomic update when the move empties it and confirmEmptyDeletion is true", async () => {
    const { tenant, repo } = await seed();
    const source = await insertAtomic(tenant.id, "Source");
    const target = await insertAtomic(tenant.id, "Target");
    const event = await insertEvent(tenant.id, repo.id, "sha-empty-source", { atomicUpdateId: source.id });
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await reassignChangeEvent(
      {
        tenantId: tenant.id,
        userId: USER,
        eventId: event.id,
        target: { kind: "existing", atomicUpdateId: target.id },
        confirmEmptyDeletion: true,
      },
      { refresh }
    );

    expect(result).toEqual({ ok: true, deletedAtomicUpdate: { id: source.id, title: "Source" } });

    const [gone] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, source.id));
    expect(gone).toBeUndefined();

    expect(refresh).toHaveBeenCalledTimes(1);
    const [, , ids] = refresh.mock.calls[0];
    expect(ids).toEqual([target.id]);
  });

  it("detach sets atomicUpdateId null, status excluded, and records excludedBy", async () => {
    const { tenant, repo } = await seed();
    const source = await insertAtomic(tenant.id, "Source");
    const keep = await insertEvent(tenant.id, repo.id, "sha-keep", { atomicUpdateId: source.id });
    const event = await insertEvent(tenant.id, repo.id, "sha-detach", { atomicUpdateId: source.id });
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await reassignChangeEvent(
      { tenantId: tenant.id, userId: USER, eventId: event.id, target: { kind: "detach" } },
      { refresh }
    );

    expect(result).toEqual({ ok: true });

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).toBeNull();
    expect(updated.status).toBe("excluded");
    expect(updated.excludedAt).not.toBeNull();
    expect(updated.excludedBy).toBe(USER);

    // Source survives (still has `keep`).
    const [survivingSource] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, source.id));
    expect(survivingSource).toBeDefined();

    void keep;
  });

  it("new creates a fresh open atomic update seeded from the event and links it", async () => {
    const { tenant, repo } = await seed();
    const source = await insertAtomic(tenant.id, "Source");
    const event = await insertEvent(tenant.id, repo.id, "sha-new", {
      atomicUpdateId: source.id,
      prTitle: "Add CSV export",
      impactSummary: "Users can export data as CSV.",
      suggestedCategory: "new",
    });
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await reassignChangeEvent(
      {
        tenantId: tenant.id,
        userId: USER,
        eventId: event.id,
        target: { kind: "new" },
        confirmEmptyDeletion: true,
      },
      { refresh }
    );

    expect(result.ok).toBe(true);

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).not.toBeNull();
    expect(updated.atomicUpdateId).not.toBe(source.id);
    expect(updated.status).toBe("pending");

    const [created] = await db
      .select()
      .from(atomicUpdates)
      .where(eq(atomicUpdates.id, updated.atomicUpdateId!));
    expect(created.title).toBe("Add CSV export");
    expect(created.summary).toBe("Users can export data as CSV.");
    expect(created.category).toBe("new");
    expect(created.status).toBe("open");
    expect(created.tenantId).toBe(tenant.id);

    // Source AU is now empty (it had only `event`), so it's deleted.
    const [gone] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, source.id));
    expect(gone).toBeUndefined();
    expect(result).toEqual({ ok: true, deletedAtomicUpdate: { id: source.id, title: "Source" } });
  });

  it("new falls back to first line of commitMessage and title when impactSummary/prTitle are absent", async () => {
    const { tenant, repo } = await seed();
    const event = await insertEvent(tenant.id, repo.id, "sha-new-fallback", {
      commitMessage: "Fix off-by-one\n\nLonger body here.",
    });
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await reassignChangeEvent(
      { tenantId: tenant.id, userId: USER, eventId: event.id, target: { kind: "new" } },
      { refresh }
    );
    expect(result).toEqual({ ok: true });

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    const [created] = await db
      .select()
      .from(atomicUpdates)
      .where(eq(atomicUpdates.id, updated.atomicUpdateId!));
    expect(created.title).toBe("Fix off-by-one");
    expect(created.summary).toBe("Fix off-by-one");
    expect(created.category).toBeNull();
  });

  it("rescues an ignored/filtered event: existing target lands atomicUpdateId=target, status=pending", async () => {
    const { tenant, repo } = await seed();
    const target = await insertAtomic(tenant.id, "Target");
    const event = await insertEvent(tenant.id, repo.id, "sha-ignored", {
      status: "ignored",
      filterReason: "chore_prefix",
      userFacing: false,
    });
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await reassignChangeEvent(
      { tenantId: tenant.id, userId: USER, eventId: event.id, target: { kind: "existing", atomicUpdateId: target.id } },
      { refresh }
    );

    expect(result).toEqual({ ok: true });
    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).toBe(target.id);
    expect(updated.status).toBe("pending");
  });

  it("rescues a non-user-facing event via new", async () => {
    const { tenant, repo } = await seed();
    const event = await insertEvent(tenant.id, repo.id, "sha-non-user-facing", {
      status: "ignored",
      userFacing: false,
      commitMessage: "internal chore",
    });
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await reassignChangeEvent(
      { tenantId: tenant.id, userId: USER, eventId: event.id, target: { kind: "new" } },
      { refresh }
    );

    expect(result).toEqual({ ok: true });
    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).not.toBeNull();
    expect(updated.status).toBe("pending");
  });

  it("rejects moving an event out of a released atomic update", async () => {
    const { tenant, repo } = await seed();
    const released = await insertAtomic(tenant.id, "Shipped", { status: "released" });
    const target = await insertAtomic(tenant.id, "Target");
    const event = await insertEvent(tenant.id, repo.id, "sha-released-source", { atomicUpdateId: released.id });
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await reassignChangeEvent(
      { tenantId: tenant.id, userId: USER, eventId: event.id, target: { kind: "existing", atomicUpdateId: target.id } },
      { refresh }
    );

    expect(result.ok).toBe(false);
    const [unchanged] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(unchanged.atomicUpdateId).toBe(released.id);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects targeting a released atomic update via existing", async () => {
    const { tenant, repo } = await seed();
    const released = await insertAtomic(tenant.id, "Shipped", { status: "released" });
    const event = await insertEvent(tenant.id, repo.id, "sha-released-target");
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await reassignChangeEvent(
      { tenantId: tenant.id, userId: USER, eventId: event.id, target: { kind: "existing", atomicUpdateId: released.id } },
      { refresh }
    );

    expect(result.ok).toBe(false);
    const [unchanged] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(unchanged.atomicUpdateId).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects a cross-tenant event and mutates nothing", async () => {
    const { tenant } = await seed();
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
    const foreign = await insertEvent(other.id, otherRepo.id, "sha-foreign");
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await reassignChangeEvent(
      { tenantId: tenant.id, userId: USER, eventId: foreign.id, target: { kind: "existing", atomicUpdateId: target.id } },
      { refresh }
    );

    expect(result.ok).toBe(false);
    const [unchanged] = await db.select().from(changeEvents).where(eq(changeEvents.id, foreign.id));
    expect(unchanged.atomicUpdateId).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects a cross-tenant target atomic update and mutates nothing", async () => {
    const { tenant, repo } = await seed();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const foreignTarget = await insertAtomic(other.id, "Foreign Target");
    const event = await insertEvent(tenant.id, repo.id, "sha-cross-target");
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await reassignChangeEvent(
      {
        tenantId: tenant.id,
        userId: USER,
        eventId: event.id,
        target: { kind: "existing", atomicUpdateId: foreignTarget.id },
      },
      { refresh }
    );

    expect(result.ok).toBe(false);
    const [unchanged] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(unchanged.atomicUpdateId).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("returns ok:false for a nonexistent event and mutates nothing", async () => {
    const { tenant } = await seed();
    const target = await insertAtomic(tenant.id, "Target");
    const refresh = vi.fn().mockResolvedValue(undefined);

    const result = await reassignChangeEvent(
      {
        tenantId: tenant.id,
        userId: USER,
        eventId: "00000000-0000-0000-0000-000000000099",
        target: { kind: "existing", atomicUpdateId: target.id },
      },
      { refresh }
    );

    expect(result.ok).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not fail the reassign when refresh throws (best-effort regen)", async () => {
    const { tenant, repo } = await seed();
    const target = await insertAtomic(tenant.id, "Target");
    const event = await insertEvent(tenant.id, repo.id, "sha-refresh-fails");
    const refresh = vi.fn().mockRejectedValue(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await reassignChangeEvent(
      { tenantId: tenant.id, userId: USER, eventId: event.id, target: { kind: "existing", atomicUpdateId: target.id } },
      { refresh }
    );

    expect(result).toEqual({ ok: true });
    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).toBe(target.id);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("openAtomicUpdatesForReassign returns all open AUs including one already in a draft release, excludes released", async () => {
    const { tenant } = await seed();
    const openUnclaimed = await insertAtomic(tenant.id, "Open unclaimed");
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "Draft", body: "B" })
      .returning();
    const openInDraft = await insertAtomic(tenant.id, "Open in draft", { releaseId: release.id });
    await insertAtomic(tenant.id, "Released", { status: "released" });

    const open = await openAtomicUpdatesForReassign(tenant.id);
    const ids = open.map((a) => a.id);
    expect(ids).toContain(openUnclaimed.id);
    expect(ids).toContain(openInDraft.id);
    expect(open.every((a) => a.status === "open")).toBe(true);
  });

  describe("confirm-before-empty-deletion (Finding 2)", () => {
    it("an unconfirmed move that would empty the source AU performs no mutation and asks for confirmation", async () => {
      const { tenant, repo } = await seed();
      const source = await insertAtomic(tenant.id, "Source");
      const target = await insertAtomic(tenant.id, "Target");
      const event = await insertEvent(tenant.id, repo.id, "sha-needs-confirm", { atomicUpdateId: source.id });
      const refresh = vi.fn().mockResolvedValue(undefined);

      const result = await reassignChangeEvent(
        { tenantId: tenant.id, userId: USER, eventId: event.id, target: { kind: "existing", atomicUpdateId: target.id } },
        { refresh }
      );

      expect(result).toEqual({
        ok: false,
        reason: "needs_confirmation",
        needsConfirmation: true,
        emptiedAtomicUpdate: { id: source.id, title: "Source", inDraft: false },
      });

      // No mutation: the event did not move, and the source AU still exists.
      const [unchanged] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
      expect(unchanged.atomicUpdateId).toBe(source.id);

      const [stillThere] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, source.id));
      expect(stillThere).toBeDefined();

      expect(refresh).not.toHaveBeenCalled();
    });

    it("the same move with confirmEmptyDeletion:true moves the event and deletes the emptied AU", async () => {
      const { tenant, repo } = await seed();
      const source = await insertAtomic(tenant.id, "Source");
      const target = await insertAtomic(tenant.id, "Target");
      const event = await insertEvent(tenant.id, repo.id, "sha-confirmed", { atomicUpdateId: source.id });
      const refresh = vi.fn().mockResolvedValue(undefined);

      const result = await reassignChangeEvent(
        {
          tenantId: tenant.id,
          userId: USER,
          eventId: event.id,
          target: { kind: "existing", atomicUpdateId: target.id },
          confirmEmptyDeletion: true,
        },
        { refresh }
      );

      expect(result).toEqual({ ok: true, deletedAtomicUpdate: { id: source.id, title: "Source" } });

      const [moved] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
      expect(moved.atomicUpdateId).toBe(target.id);

      const [gone] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, source.id));
      expect(gone).toBeUndefined();
    });

    it("emptiedAtomicUpdate.inDraft is true when the source AU has a releaseId", async () => {
      const { tenant, repo } = await seed();
      const [release] = await db
        .insert(releases)
        .values({ tenantId: tenant.id, title: "Draft", body: "B" })
        .returning();
      const source = await insertAtomic(tenant.id, "Source in draft", { releaseId: release.id });
      const target = await insertAtomic(tenant.id, "Target");
      const event = await insertEvent(tenant.id, repo.id, "sha-in-draft", { atomicUpdateId: source.id });
      const refresh = vi.fn().mockResolvedValue(undefined);

      const result = await reassignChangeEvent(
        { tenantId: tenant.id, userId: USER, eventId: event.id, target: { kind: "existing", atomicUpdateId: target.id } },
        { refresh }
      );

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({
        needsConfirmation: true,
        emptiedAtomicUpdate: { id: source.id, title: "Source in draft", inDraft: true },
      });
    });

    it("a move that does not empty the source AU never asks for confirmation", async () => {
      const { tenant, repo } = await seed();
      const source = await insertAtomic(tenant.id, "Source");
      const target = await insertAtomic(tenant.id, "Target");
      const kept = await insertEvent(tenant.id, repo.id, "sha-kept-behind", { atomicUpdateId: source.id });
      const event = await insertEvent(tenant.id, repo.id, "sha-not-emptying", { atomicUpdateId: source.id });
      const refresh = vi.fn().mockResolvedValue(undefined);

      const result = await reassignChangeEvent(
        { tenantId: tenant.id, userId: USER, eventId: event.id, target: { kind: "existing", atomicUpdateId: target.id } },
        { refresh }
      );

      expect(result).toEqual({ ok: true });
      const [moved] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
      expect(moved.atomicUpdateId).toBe(target.id);

      void kept;
    });
  });

  describe("forceRegenerate (Task 2)", () => {
    it("load-bearing: forceRegenerate:true clears a frozen target's summaryEditedAt before refresh runs", async () => {
      const { tenant, repo } = await seed();
      const target = await insertAtomic(tenant.id, "Target", { summaryEditedAt: new Date() });
      const event = await insertEvent(tenant.id, repo.id, "sha-force-regen");
      const refresh = vi.fn().mockResolvedValue(undefined);

      const result = await reassignChangeEvent(
        {
          tenantId: tenant.id,
          userId: USER,
          eventId: event.id,
          target: { kind: "existing", atomicUpdateId: target.id },
          forceRegenerate: true,
        },
        { refresh }
      );

      expect(result).toEqual({ ok: true });

      const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, target.id));
      expect(after.summaryEditedAt).toBeNull();

      expect(refresh).toHaveBeenCalledTimes(1);
      const [, , ids] = refresh.mock.calls[0];
      expect(ids).toContain(target.id);
    });

    it("contrast: forceRegenerate false/absent leaves the target's summaryEditedAt SET (freeze intact)", async () => {
      const { tenant, repo } = await seed();
      const target = await insertAtomic(tenant.id, "Target", { summaryEditedAt: new Date() });
      const event = await insertEvent(tenant.id, repo.id, "sha-no-force-regen");
      const refresh = vi.fn().mockResolvedValue(undefined);

      const result = await reassignChangeEvent(
        {
          tenantId: tenant.id,
          userId: USER,
          eventId: event.id,
          target: { kind: "existing", atomicUpdateId: target.id },
          // forceRegenerate omitted entirely.
        },
        { refresh }
      );

      expect(result).toEqual({ ok: true });

      const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, target.id));
      expect(after.summaryEditedAt).not.toBeNull();

      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("forceRegenerate:true also clears the freeze on the surviving source atomic update", async () => {
      const { tenant, repo } = await seed();
      const source = await insertAtomic(tenant.id, "Source", { summaryEditedAt: new Date() });
      const target = await insertAtomic(tenant.id, "Target", { summaryEditedAt: new Date() });
      const kept = await insertEvent(tenant.id, repo.id, "sha-force-kept", { atomicUpdateId: source.id });
      const event = await insertEvent(tenant.id, repo.id, "sha-force-moved", { atomicUpdateId: source.id });
      const refresh = vi.fn().mockResolvedValue(undefined);

      const result = await reassignChangeEvent(
        {
          tenantId: tenant.id,
          userId: USER,
          eventId: event.id,
          target: { kind: "existing", atomicUpdateId: target.id },
          forceRegenerate: true,
        },
        { refresh }
      );

      expect(result).toEqual({ ok: true });

      const [survivingSource] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, source.id));
      expect(survivingSource.summaryEditedAt).toBeNull();
      const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, target.id));
      expect(after.summaryEditedAt).toBeNull();

      expect(refresh).toHaveBeenCalledTimes(1);
      const [, , ids] = refresh.mock.calls[0];
      expect(new Set(ids)).toEqual(new Set([target.id, source.id]));

      void kept;
    });

    it("forceRegenerate:true is a no-op when refresh is never called (needs_confirmation short-circuits before the clear)", async () => {
      const { tenant, repo } = await seed();
      const source = await insertAtomic(tenant.id, "Source", { summaryEditedAt: new Date() });
      const target = await insertAtomic(tenant.id, "Target");
      const event = await insertEvent(tenant.id, repo.id, "sha-force-needs-confirm", { atomicUpdateId: source.id });
      const refresh = vi.fn().mockResolvedValue(undefined);

      const result = await reassignChangeEvent(
        {
          tenantId: tenant.id,
          userId: USER,
          eventId: event.id,
          target: { kind: "existing", atomicUpdateId: target.id },
          forceRegenerate: true,
        },
        { refresh }
      );

      expect(result.ok).toBe(false);
      expect((result as { needsConfirmation?: boolean }).needsConfirmation).toBe(true);

      const [unchangedSource] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, source.id));
      expect(unchangedSource.summaryEditedAt).not.toBeNull();
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  describe("deterministic updatedAt bump fires the catch-up evidence delta (Finding 1)", () => {
    it("bumps updatedAt on a still-open, in-draft target even when refresh is a no-op and the summary is hand-edited", async () => {
      const { tenant, repo } = await seed();
      const composedAt = new Date(Date.now() - 60_000);
      const [release] = await db
        .insert(releases)
        .values({ tenantId: tenant.id, title: "Draft", body: "B", composedAt })
        .returning();
      // Hand-edited summary: `refreshAtomicUpdates` would skip regenerating
      // this atomic update's text, so if the evidence delta depended on regen
      // alone it would never fire for this move.
      const target = await insertAtomic(tenant.id, "In-draft target", {
        releaseId: release.id,
        summaryEditedAt: new Date(),
        updatedAt: composedAt,
      });
      const event = await insertEvent(tenant.id, repo.id, "sha-catch-up");
      // A stubbed refresh that does nothing — proves the delta fires from the
      // in-transaction bump, not from regeneration.
      const refresh = vi.fn().mockResolvedValue(undefined);

      const result = await reassignChangeEvent(
        { tenantId: tenant.id, userId: USER, eventId: event.id, target: { kind: "existing", atomicUpdateId: target.id } },
        { refresh }
      );
      expect(result).toEqual({ ok: true });

      const delta = await computeReleaseDelta(release.id);
      expect(delta.count).toBeGreaterThanOrEqual(1);
      expect(delta.changedAtomicUpdates.map((a) => a.id)).toContain(target.id);
    });
  });
});
