import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, atomicUpdates } from "../../../src/db/schema";

const TENANT = "Change Events Actions Test Tenant";

// bulkReassignChangeEvents only orchestrates: run each event through the core
// with the given identity/target and confirmEmptyDeletion:true, then tally
// the outcomes. The core's own transactional behavior is covered by
// tests/lib/change-events/reassign.test.ts. Mocking it here keeps this test
// from touching the real regeneration path, which would otherwise reach the
// live Anthropic API per the task's hard constraint.
vi.mock("../../../src/lib/change-events/reassign", () => ({
  reassignChangeEvent: vi.fn(async () => ({ ok: true })),
}));

import { listChangeEvents, bulkReassignChangeEvents, bulkDeleteChangeEvents } from "../../../src/lib/change-events/list";
import { reassignChangeEvent } from "../../../src/lib/change-events/reassign";

async function seedRepo(tenantId: string) {
  const [repo] = await db
    .insert(repos)
    .values({
      tenantId,
      githubRepoFullName: "acme/widgets",
      githubInstallationId: "1",
      watchedBranch: "main",
    })
    .returning();
  return repo;
}

describe("listChangeEvents", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("shows an assigned event regardless of userFacing/filterReason", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Atomic", summary: "S" })
      .returning();

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-assigned",
      commitSha: "sha-assigned",
      commitMessage: "assigned but filtered",
      atomicUpdateId: atomic.id,
      userFacing: false,
      filterReason: "chore_prefix",
    });

    const rows = await listChangeEvents(tenant.id, {});
    expect(rows.map((r) => r.title)).toEqual(["assigned but filtered"]);
    expect(rows[0].atomicUpdateId).toBe(atomic.id);
    expect(rows[0].atomicUpdateTitle).toBe("Atomic");
  });

  it("uses taskTitle for a Notion task's title", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: null,
      type: "task",
      provider: "notion",
      externalId: "page-title-1",
      taskTitle: "Fix SSO login",
      userFacing: true,
    });

    const rows = await listChangeEvents(tenant.id, {});
    expect(rows.map((r) => r.title)).toEqual(["Fix SSO login"]);
  });

  it("hides an unassigned filterReason-set event by default, shows it with showHidden", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-filtered",
      commitSha: "sha-filtered",
      commitMessage: "filtered out commit",
      filterReason: "lockfile_only",
    });

    const hidden = await listChangeEvents(tenant.id, {});
    expect(hidden.map((r) => r.title)).toEqual([]);

    const shown = await listChangeEvents(tenant.id, { showHidden: true });
    expect(shown.map((r) => r.title)).toEqual(["filtered out commit"]);
    expect(shown[0].atomicUpdateId).toBeNull();
    expect(shown[0].atomicUpdateTitle).toBeNull();
  });

  it("hides an unassigned userFacing:false event by default, shows it with showHidden", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-not-user-facing",
      commitSha: "sha-not-user-facing",
      commitMessage: "internal refactor",
      userFacing: false,
    });

    const hidden = await listChangeEvents(tenant.id, {});
    expect(hidden.map((r) => r.title)).toEqual([]);

    const shown = await listChangeEvents(tenant.id, { showHidden: true });
    expect(shown.map((r) => r.title)).toEqual(["internal refactor"]);
  });

  it("hides an unassigned status:excluded event by default, shows it with showHidden", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-excluded",
      commitSha: "sha-excluded",
      commitMessage: "manually excluded commit",
      status: "excluded",
      excludedAt: new Date(),
    });

    const hidden = await listChangeEvents(tenant.id, {});
    expect(hidden.map((r) => r.title)).toEqual([]);

    const shown = await listChangeEvents(tenant.id, { showHidden: true });
    expect(shown.map((r) => r.title)).toEqual(["manually excluded commit"]);
  });

  it("narrows by type and provider filters", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-typed",
      commitSha: "sha-typed",
      commitMessage: "a commit",
    });
    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "pull_request",
      provider: "github",
      externalId: "acme/widgets#7",
      prNumber: 7,
      prTitle: "a pull request",
    });

    const commitsOnly = await listChangeEvents(tenant.id, { type: "commit" });
    expect(commitsOnly.map((r) => r.title)).toEqual(["a commit"]);

    const prsOnly = await listChangeEvents(tenant.id, { provider: "github", type: "pull_request" });
    expect(prsOnly.map((r) => r.title)).toEqual(["a pull request"]);
  });

  it("filters by assignment: unassigned returns only atomicUpdateId IS NULL, assigned only IS NOT NULL", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Atomic", summary: "S" })
      .returning();

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-a",
      commitSha: "sha-a",
      commitMessage: "assigned commit",
      atomicUpdateId: atomic.id,
    });
    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-b",
      commitSha: "sha-b",
      commitMessage: "unassigned commit",
    });

    const unassigned = await listChangeEvents(tenant.id, { assignment: "unassigned" });
    expect(unassigned.map((r) => r.title)).toEqual(["unassigned commit"]);

    const assigned = await listChangeEvents(tenant.id, { assignment: "assigned" });
    expect(assigned.map((r) => r.title)).toEqual(["assigned commit"]);
  });

  it("never returns another tenant's events", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const ownRepo = await seedRepo(tenant.id);
    const foreignRepo = await seedRepo(other.id);

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: ownRepo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-mine",
      commitSha: "sha-mine",
      commitMessage: "my change",
    });
    await db.insert(changeEvents).values({
      tenantId: other.id,
      repoId: foreignRepo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-theirs",
      commitSha: "sha-theirs",
      commitMessage: "their change",
    });

    const rows = await listChangeEvents(tenant.id, { showHidden: true });
    expect(rows.map((r) => r.title)).toEqual(["my change"]);
  });

  it("orders newest first with id as a stable tiebreak", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-older",
      commitSha: "sha-older",
      commitMessage: "older commit",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-newer",
      commitSha: "sha-newer",
      commitMessage: "newer commit",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });

    const rows = await listChangeEvents(tenant.id, {});
    expect(rows.map((r) => r.title)).toEqual(["newer commit", "older commit"]);
  });

  it("derives title from prTitle over commitMessage's first line, falling back to Untitled", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "pull_request",
      provider: "github",
      externalId: "acme/widgets#9",
      prNumber: 9,
      prTitle: "Ship the widget",
    });
    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-multiline",
      commitSha: "sha-multiline",
      commitMessage: "first line\n\nbody text",
    });
    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "task",
      provider: "notion",
      externalId: "task-1",
    });

    const rows = await listChangeEvents(tenant.id, { showHidden: true });
    expect(rows.find((r) => r.type === "pull_request")!.title).toBe("Ship the widget");
    expect(rows.find((r) => r.type === "commit")!.title).toBe("first line");
    expect(rows.find((r) => r.type === "task")!.title).toBe("Untitled");
  });

  it("returns only unassigned events, and empty when everything is grouped", async () => {
    const tenant = (await db.insert(tenants).values({ name: TENANT }).returning())[0];
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Grouped", summary: "S" })
      .returning();
    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      type: "pull_request",
      provider: "github",
      externalId: "pr-grouped",
      prTitle: "Already grouped",
      atomicUpdateId: atomic.id,
    });

    expect(await listChangeEvents(tenant.id, { assignment: "unassigned" })).toEqual([]);

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      type: "pull_request",
      provider: "github",
      externalId: "pr-loose",
      prTitle: "Not grouped",
      userFacing: true,
    });

    const loose = await listChangeEvents(tenant.id, { assignment: "unassigned" });
    expect(loose).toHaveLength(1);
    expect(loose[0].title).toBe("Not grouped");
  });
});

describe("bulkReassignChangeEvents", () => {
  const BULK_TENANT = "bulk-reassign-session-tenant";
  const BULK_USER = "bulk-reassign-session-user";

  afterEach(() => {
    vi.mocked(reassignChangeEvent).mockReset();
    vi.mocked(reassignChangeEvent).mockResolvedValue({ ok: true });
  });

  it("runs each event through the core with the given identity, the given target, and confirmEmptyDeletion:true", async () => {
    await bulkReassignChangeEvents({
      tenantId: BULK_TENANT,
      userId: BULK_USER,
      eventIds: ["e1", "e2"],
      target: { kind: "existing", atomicUpdateId: "au-9" },
    });

    expect(reassignChangeEvent).toHaveBeenCalledTimes(2);
    expect(reassignChangeEvent).toHaveBeenNthCalledWith(1, {
      tenantId: BULK_TENANT,
      userId: BULK_USER,
      eventId: "e1",
      target: { kind: "existing", atomicUpdateId: "au-9" },
      confirmEmptyDeletion: true,
    });
    expect(reassignChangeEvent).toHaveBeenNthCalledWith(2, {
      tenantId: BULK_TENANT,
      userId: BULK_USER,
      eventId: "e2",
      target: { kind: "existing", atomicUpdateId: "au-9" },
      confirmEmptyDeletion: true,
    });
  });

  it("aggregates successes, failures, and emptied-atomic-update deletions", async () => {
    vi.mocked(reassignChangeEvent)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, deletedAtomicUpdate: { id: "au-x", title: "Emptied" } })
      .mockResolvedValueOnce({ ok: false, reason: "Cannot move an event out of a published atomic update." });

    const result = await bulkReassignChangeEvents({
      tenantId: BULK_TENANT,
      userId: BULK_USER,
      eventIds: ["e1", "e2", "e3"],
      target: { kind: "detach" },
    });

    expect(result).toEqual({ succeeded: 2, failed: 1, deletedAtomicUpdates: 1 });
  });

  it("does no work and returns zeros for an empty selection", async () => {
    const result = await bulkReassignChangeEvents({
      tenantId: BULK_TENANT,
      userId: BULK_USER,
      eventIds: [],
      target: { kind: "detach" },
    });

    expect(result).toEqual({ succeeded: 0, failed: 0, deletedAtomicUpdates: 0 });
    expect(reassignChangeEvent).not.toHaveBeenCalled();
  });
});

describe("bulkDeleteChangeEvents", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("hard-deletes selected unassigned and open-linked events, keeping published-release evidence", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);
    const [open] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Open AU", summary: "S" })
      .returning();
    const [released] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Shipped AU", summary: "S", status: "released" })
      .returning();

    const [unassigned] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        type: "commit",
        provider: "github",
        externalId: "sha-unassigned",
        commitSha: "sha-unassigned",
        commitMessage: "junk",
      })
      .returning();
    const [linkedOpen] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        type: "commit",
        provider: "github",
        externalId: "sha-open",
        commitSha: "sha-open",
        commitMessage: "in open au",
        atomicUpdateId: open.id,
      })
      .returning();
    const [linkedReleased] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        type: "commit",
        provider: "github",
        externalId: "sha-released",
        commitSha: "sha-released",
        commitMessage: "shipped evidence",
        atomicUpdateId: released.id,
      })
      .returning();

    const result = await bulkDeleteChangeEvents(tenant.id, [unassigned.id, linkedOpen.id, linkedReleased.id]);

    expect(result).toEqual({ count: 2 });
    const survivors = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tenant.id));
    expect(survivors.map((r) => r.id)).toEqual([linkedReleased.id]);
  });

  it("never deletes another tenant's events", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const foreignRepo = await seedRepo(other.id);
    const [foreign] = await db
      .insert(changeEvents)
      .values({
        tenantId: other.id,
        repoId: foreignRepo.id,
        type: "commit",
        provider: "github",
        externalId: "sha-foreign",
        commitSha: "sha-foreign",
        commitMessage: "theirs",
      })
      .returning();

    const result = await bulkDeleteChangeEvents(tenant.id, [foreign.id]);

    expect(result).toEqual({ count: 0 });
    const [stillThere] = await db.select().from(changeEvents).where(eq(changeEvents.id, foreign.id));
    expect(stillThere).toBeDefined();
  });

  it("returns count 0 for an empty selection", async () => {
    const result = await bulkDeleteChangeEvents("nonexistent-tenant", []);
    expect(result).toEqual({ count: 0 });
  });
});
