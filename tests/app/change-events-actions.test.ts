import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeEvents, atomicUpdates } from "../../src/db/schema";

const TENANT = "Change Events Actions Test Tenant";
let currentTenantId = "";
let currentUserId: string | null = "user-1";

// requireSession() returns a NextAuth Session (tenantId lives under `user`,
// per src/types/next-auth.d.ts) — mirror that shape rather than a flat one,
// so the mock matches what the real module actually returns. Pattern copied
// from tests/app/atomic-updates-actions.test.ts.
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The reassign action only orchestrates: derive tenant/user from the (mocked)
// session, parse the target off formData, call reassignChangeEvent, and
// revalidate. The core's own tenant re-validation and transactional behavior
// is covered by tests/lib/change-events/reassign.test.ts — mocking it here
// keeps this test from touching Postgres for the reassign path and, per the
// task's hard constraint, never reaches the live Anthropic API.
vi.mock("../../src/lib/change-events/reassign", () => ({
  reassignChangeEvent: vi.fn(async () => ({ ok: true })),
}));

import { listChangeEvents, reassign } from "../../src/app/(dashboard)/change-events/actions";
import { reassignChangeEvent } from "../../src/lib/change-events/reassign";
import { revalidatePath } from "next/cache";

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
    currentTenantId = tenant.id;
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

    const rows = await listChangeEvents({});
    expect(rows.map((r) => r.title)).toEqual(["assigned but filtered"]);
    expect(rows[0].atomicUpdateId).toBe(atomic.id);
    expect(rows[0].atomicUpdateTitle).toBe("Atomic");
  });

  it("hides an unassigned filterReason-set event by default, shows it with showHidden", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
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

    const hidden = await listChangeEvents({});
    expect(hidden.map((r) => r.title)).toEqual([]);

    const shown = await listChangeEvents({ showHidden: true });
    expect(shown.map((r) => r.title)).toEqual(["filtered out commit"]);
    expect(shown[0].atomicUpdateId).toBeNull();
    expect(shown[0].atomicUpdateTitle).toBeNull();
  });

  it("hides an unassigned userFacing:false event by default, shows it with showHidden", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
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

    const hidden = await listChangeEvents({});
    expect(hidden.map((r) => r.title)).toEqual([]);

    const shown = await listChangeEvents({ showHidden: true });
    expect(shown.map((r) => r.title)).toEqual(["internal refactor"]);
  });

  it("hides an unassigned status:excluded event by default, shows it with showHidden", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
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

    const hidden = await listChangeEvents({});
    expect(hidden.map((r) => r.title)).toEqual([]);

    const shown = await listChangeEvents({ showHidden: true });
    expect(shown.map((r) => r.title)).toEqual(["manually excluded commit"]);
  });

  it("narrows by type and provider filters", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
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

    const commitsOnly = await listChangeEvents({ type: "commit" });
    expect(commitsOnly.map((r) => r.title)).toEqual(["a commit"]);

    const prsOnly = await listChangeEvents({ provider: "github", type: "pull_request" });
    expect(prsOnly.map((r) => r.title)).toEqual(["a pull request"]);
  });

  it("filters by assignment: unassigned returns only atomicUpdateId IS NULL, assigned only IS NOT NULL", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
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

    const unassigned = await listChangeEvents({ assignment: "unassigned" });
    expect(unassigned.map((r) => r.title)).toEqual(["unassigned commit"]);

    const assigned = await listChangeEvents({ assignment: "assigned" });
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

    currentTenantId = tenant.id;
    const rows = await listChangeEvents({ showHidden: true });
    expect(rows.map((r) => r.title)).toEqual(["my change"]);
  });

  it("orders newest first with id as a stable tiebreak", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
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

    const rows = await listChangeEvents({});
    expect(rows.map((r) => r.title)).toEqual(["newer commit", "older commit"]);
  });

  it("derives title from prTitle over commitMessage's first line, falling back to Untitled", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
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

    const rows = await listChangeEvents({ showHidden: true });
    expect(rows.find((r) => r.type === "pull_request")!.title).toBe("Ship the widget");
    expect(rows.find((r) => r.type === "commit")!.title).toBe("first line");
    expect(rows.find((r) => r.type === "task")!.title).toBe("Untitled");
  });
});

describe("reassign", () => {
  const REASSIGN_TENANT = "reassign-session-tenant";
  const REASSIGN_USER = "reassign-session-user";

  afterEach(() => {
    vi.mocked(reassignChangeEvent).mockClear();
    vi.mocked(revalidatePath).mockClear();
    currentTenantId = "";
    currentUserId = "user-1";
  });

  it("calls reassignChangeEvent with the session's tenantId/userId and the parsed 'existing' target, then revalidates", async () => {
    currentTenantId = REASSIGN_TENANT;
    currentUserId = REASSIGN_USER;

    const formData = new FormData();
    formData.set("eventId", "event-1");
    formData.set("targetKind", "existing");
    formData.set("atomicUpdateId", "au-1");

    const result = await reassign(formData);

    expect(reassignChangeEvent).toHaveBeenCalledWith({
      tenantId: REASSIGN_TENANT,
      userId: REASSIGN_USER,
      eventId: "event-1",
      target: { kind: "existing", atomicUpdateId: "au-1" },
      confirmEmptyDeletion: false,
    });
    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/change-events");
  });

  it("parses a 'detach' target with no atomicUpdateId", async () => {
    currentTenantId = REASSIGN_TENANT;
    currentUserId = REASSIGN_USER;

    const formData = new FormData();
    formData.set("eventId", "event-2");
    formData.set("targetKind", "detach");

    await reassign(formData);

    expect(reassignChangeEvent).toHaveBeenCalledWith({
      tenantId: REASSIGN_TENANT,
      userId: REASSIGN_USER,
      eventId: "event-2",
      target: { kind: "detach" },
      confirmEmptyDeletion: false,
    });
  });

  it("parses a 'new' target (split to new atomic update)", async () => {
    currentTenantId = REASSIGN_TENANT;
    currentUserId = REASSIGN_USER;

    const formData = new FormData();
    formData.set("eventId", "event-3");
    formData.set("targetKind", "new");

    await reassign(formData);

    expect(reassignChangeEvent).toHaveBeenCalledWith({
      tenantId: REASSIGN_TENANT,
      userId: REASSIGN_USER,
      eventId: "event-3",
      target: { kind: "new" },
      confirmEmptyDeletion: false,
    });
  });

  it("derives tenantId/userId from the session, ignoring any tenantId/userId fields present on formData", async () => {
    currentTenantId = REASSIGN_TENANT;
    currentUserId = REASSIGN_USER;

    const formData = new FormData();
    formData.set("eventId", "event-4");
    formData.set("targetKind", "detach");
    // A malicious or stale client could stuff these in; the action must never
    // read them.
    formData.set("tenantId", "some-other-tenant");
    formData.set("userId", "some-other-user");

    await reassign(formData);

    expect(reassignChangeEvent).toHaveBeenCalledWith({
      tenantId: REASSIGN_TENANT,
      userId: REASSIGN_USER,
      eventId: "event-4",
      target: { kind: "detach" },
      confirmEmptyDeletion: false,
    });
  });

  it("returns {ok:false, reason} from the core without throwing, and still revalidates", async () => {
    currentTenantId = REASSIGN_TENANT;
    currentUserId = REASSIGN_USER;
    vi.mocked(reassignChangeEvent).mockResolvedValueOnce({
      ok: false,
      reason: "Cannot move an event out of a published atomic update.",
    });

    const formData = new FormData();
    formData.set("eventId", "event-5");
    formData.set("targetKind", "existing");
    formData.set("atomicUpdateId", "au-2");

    const result = await reassign(formData);

    expect(result).toEqual({
      ok: false,
      reason: "Cannot move an event out of a published atomic update.",
    });
  });
});
