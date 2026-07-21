import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, atomicUpdates, updates } from "../../../src/db/schema";
import {
  applyResolution,
  loadOpenAtomicUpdates,
  withTenantLock,
} from "../../../src/lib/change-events/apply-resolution";

const TENANT = "Apply Resolution Test Tenant";

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
  return { tenant, repo };
}

async function insertEvent(tenantId: string, repoId: string, sha: string) {
  const [row] = await db
    .insert(changeEvents)
    .values({
      tenantId,
      repoId,
      type: "commit",
      provider: "github",
      externalId: sha,
      commitSha: sha,
      commitMessage: sha,
    })
    .returning();
  return row;
}

describe("apply-resolution", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("creates an atomic update and attaches the event", async () => {
    const { tenant, repo } = await seed();
    const event = await insertEvent(tenant.id, repo.id, "sha-create");

    await applyResolution(db, tenant.id, [
      { eventId: event.id, action: "create", title: "CSV export", summary: "Export as CSV.", category: "new" },
    ]);

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).not.toBeNull();

    const [atomic] = await db
      .select()
      .from(atomicUpdates)
      .where(eq(atomicUpdates.id, updated.atomicUpdateId!));
    expect(atomic.title).toBe("CSV export");
    expect(atomic.category).toBe("new");
    expect(atomic.status).toBe("open");
  });

  it("merges same-title create actions into one atomic update", async () => {
    const { tenant, repo } = await seed();
    const first = await insertEvent(tenant.id, repo.id, "sha-merge-1");
    const second = await insertEvent(tenant.id, repo.id, "sha-merge-2");

    await applyResolution(db, tenant.id, [
      { eventId: first.id, action: "create", title: "CSV export", summary: "Export as CSV.", category: "new" },
      { eventId: second.id, action: "create", title: "CSV Export", summary: "Export as CSV.", category: "new" },
    ]);

    const rows = await db.select().from(atomicUpdates).where(eq(atomicUpdates.tenantId, tenant.id));
    expect(rows).toHaveLength(1);

    const [a] = await db.select().from(changeEvents).where(eq(changeEvents.id, first.id));
    const [b] = await db.select().from(changeEvents).where(eq(changeEvents.id, second.id));
    expect(a.atomicUpdateId).toBe(b.atomicUpdateId);
  });

  it("assigns an event to an existing atomic update", async () => {
    const { tenant, repo } = await seed();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "CSV export", summary: "Export as CSV." })
      .returning();
    const event = await insertEvent(tenant.id, repo.id, "sha-assign");

    await applyResolution(db, tenant.id, [
      { eventId: event.id, action: "assign", atomicUpdateId: atomic.id },
    ]);

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).toBe(atomic.id);
  });

  it("ignores an empty plan", async () => {
    const { tenant, repo } = await seed();
    const event = await insertEvent(tenant.id, repo.id, "sha-noop");

    await applyResolution(db, tenant.id, []);

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).toBeNull();
  });

  it("never assigns an event belonging to another tenant", async () => {
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
    const foreign = await insertEvent(other.id, otherRepo.id, "sha-foreign");

    await applyResolution(db, tenant.id, [
      { eventId: foreign.id, action: "create", title: "X", summary: "Y", category: "new" },
    ]);

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, foreign.id));
    expect(updated.atomicUpdateId).toBeNull();
  });

  it("loadOpenAtomicUpdates returns only open ones for the tenant", async () => {
    const { tenant } = await seed();
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Open one", summary: "S" });
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Shipped one", summary: "S", status: "released" });

    const open = await loadOpenAtomicUpdates(db, tenant.id);
    expect(open).toHaveLength(1);
    expect(open[0].title).toBe("Open one");
  });

  it("loadOpenAtomicUpdates includes ones already in a draft release", async () => {
    const { tenant } = await seed();
    const [release] = await db
      .insert(updates)
      .values({ tenantId: tenant.id, title: "Draft", body: "B", sourceItems: [] })
      .returning();
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "In a draft", summary: "S", releaseId: release.id });

    const open = await loadOpenAtomicUpdates(db, tenant.id);
    expect(open.map((a) => a.title)).toContain("In a draft");
  });

  it("serializes concurrent lock holders for the same tenant", async () => {
    const { tenant } = await seed();
    const order: string[] = [];

    await Promise.all([
      withTenantLock(db, tenant.id, async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 50));
        order.push("a-end");
      }),
      withTenantLock(db, tenant.id, async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);

    // Whoever went first must have finished before the other started.
    expect(order[1]).toBe(order[0].replace("start", "end"));
  });
});
