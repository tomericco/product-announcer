import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, atomicUpdates } from "../../../src/db/schema";
import { resolvePendingEvents } from "../../../src/lib/change-events/pipeline";

const TENANT = "Pipeline Test Tenant";

async function seed(count: number) {
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

  const events = [];
  for (let i = 0; i < count; i++) {
    const [row] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        type: "commit",
        provider: "github",
        externalId: `sha-${i}`,
        commitSha: `sha-${i}`,
        commitMessage: `commit ${i}`,
        userFacing: true,
        impactSummary: `Does thing ${i}.`,
      })
      .returning();
    events.push(row);
  }
  return { tenant, events };
}

describe("resolvePendingEvents", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("creates an atomic update from the resolver plan", async () => {
    const { tenant, events } = await seed(1);
    const resolve = vi.fn().mockResolvedValue([
      { eventId: events[0].id, action: "create", title: "Thing", summary: "Does a thing.", category: "new" },
    ]);

    await resolvePendingEvents(tenant.id, [events[0].id], { resolve, refresh: vi.fn() });

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, events[0].id));
    expect(updated.atomicUpdateId).not.toBeNull();
  });

  it("chunks batches larger than the resolver cap", async () => {
    const { tenant, events } = await seed(30);
    const resolve = vi.fn().mockResolvedValue([]);

    await resolvePendingEvents(
      tenant.id,
      events.map((e) => e.id),
      { resolve, refresh: vi.fn() }
    );

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[0][0].events).toHaveLength(25);
    expect(resolve.mock.calls[1][0].events).toHaveLength(5);
  });

  it("refreshes only atomic updates that received an assignment", async () => {
    const { tenant, events } = await seed(1);
    const [existing] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Existing", summary: "S" })
      .returning();
    const refresh = vi.fn();
    const resolve = vi
      .fn()
      .mockResolvedValue([{ eventId: events[0].id, action: "assign", atomicUpdateId: existing.id }]);

    await resolvePendingEvents(tenant.id, [events[0].id], { resolve, refresh });

    expect(refresh).toHaveBeenCalledWith(expect.anything(), tenant.id, [existing.id]);
  });

  it("does nothing when given no event ids", async () => {
    const { tenant } = await seed(0);
    const resolve = vi.fn();

    await resolvePendingEvents(tenant.id, [], { resolve, refresh: vi.fn() });

    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not create duplicates when two pushes resolve concurrently", async () => {
    const { tenant, events } = await seed(2);

    // Stands in for the real resolver: assigns when it can see a match in the
    // candidate set it was handed, creates otherwise. If the lock does not span
    // loading `open` AND writing the result, the second caller reads a stale
    // candidate set, creates a second "Shared feature", and this test fails.
    const resolve = vi.fn(async ({ events: batch, open }) => {
      await new Promise((r) => setTimeout(r, 30));
      const match = open.find((a: { title: string }) => a.title === "Shared feature");
      return batch.map((e: { id: string }) =>
        match
          ? { eventId: e.id, action: "assign", atomicUpdateId: match.id }
          : { eventId: e.id, action: "create", title: "Shared feature", summary: "S", category: "new" }
      );
    });

    await Promise.all([
      resolvePendingEvents(tenant.id, [events[0].id], { resolve, refresh: vi.fn() }),
      resolvePendingEvents(tenant.id, [events[1].id], { resolve, refresh: vi.fn() }),
    ]);

    const rows = await db.select().from(atomicUpdates).where(eq(atomicUpdates.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
  });

  it("skips events that are already assigned", async () => {
    const { tenant, events } = await seed(1);
    const [existing] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Existing", summary: "S" })
      .returning();
    await db
      .update(changeEvents)
      .set({ atomicUpdateId: existing.id })
      .where(eq(changeEvents.id, events[0].id));

    const resolve = vi.fn().mockResolvedValue([]);
    await resolvePendingEvents(tenant.id, [events[0].id], { resolve, refresh: vi.fn() });

    expect(resolve).not.toHaveBeenCalled();
  });
});
