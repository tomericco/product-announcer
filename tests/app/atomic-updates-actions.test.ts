import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeEvents, atomicUpdates, releases } from "../../src/db/schema";

const TENANT = "Atomic Updates Actions Test Tenant";
let currentTenantId = "";
let currentUserId: string | null = null;

// requireSession() returns a NextAuth Session (tenantId lives under `user`,
// per src/types/next-auth.d.ts) — mirror that shape rather than a flat one,
// so the mock matches what the real module actually returns.
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// removeEventFromAtomicUpdate only orchestrates: derive tenant/user from the
// (mocked) session, build the reassign target, force regen on, call the
// core, and revalidate. The core's own transactional behavior
// (moving/detaching, the empty-source confirmation gate, the
// released-frozen guard, and — load-bearing for this task — the
// forceRegenerate freeze-clear) is covered by
// tests/lib/change-events/reassign.test.ts with a stubbed `refresh`. Mocking
// it here keeps this test from touching the real regeneration path, which
// would otherwise reach the live Anthropic API per the task's hard
// constraint.
vi.mock("../../src/lib/change-events/reassign", () => ({
  reassignChangeEvent: vi.fn(async () => ({ ok: true })),
}));

import {
  editAtomicUpdate,
  listAtomicUpdates,
  markAtomicUpdateHidden,
  bulkMarkAtomicUpdatesHidden,
  bulkDeleteAtomicUpdates,
  unhideAtomicUpdate,
  listHiddenAtomicUpdates,
  removeEventFromAtomicUpdate,
  setAtomicUpdateSize,
  setAtomicUpdateCategory,
} from "../../src/app/(dashboard)/atomic-updates/actions";
import { reassignChangeEvent } from "../../src/lib/change-events/reassign";
import { revalidatePath } from "next/cache";
import { loadOpenAtomicUpdates } from "../../src/lib/change-events/apply-resolution";

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

describe("atomic update actions", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("lists only open atomic updates for the tenant", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Open", summary: "S" });
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Shipped", summary: "S", status: "released" });

    const rows = await listAtomicUpdates();
    expect(rows.map((r) => r.title)).toEqual(["Open"]);
  });

  it("excludes an open atomic update already linked to a draft release", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "Draft", body: "B" })
      .returning();
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Open, unclaimed", summary: "S" });
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Open, but in a draft", summary: "S", releaseId: release.id });

    const rows = await listAtomicUpdates();
    expect(rows.map((r) => r.title)).toEqual(["Open, unclaimed"]);
  });

  it("sets summaryEditedAt when edited, freezing regeneration", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Before", summary: "Before summary." })
      .returning();

    await editAtomicUpdate(atomic.id, { title: "After", summary: "After summary." });

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.title).toBe("After");
    expect(after.summaryEditedAt).not.toBeNull();
  });

  it("refuses to edit another tenant's atomic update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [foreign] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S" })
      .returning();
    currentTenantId = tenant.id;

    await editAtomicUpdate(foreign.id, { title: "Hacked", summary: "Hacked." });

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreign.id));
    expect(after.title).toBe("Foreign");
  });

  it("returns each atomic update's change events with the right labels and urls", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const repo = await seedRepo(tenant.id);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "CSV export", summary: "S" })
      .returning();

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-evidence",
      commitSha: "sha-evidence",
      commitMessage: "add headers to csv\n\nLonger body explaining why.",
      commitUrl: "https://github.com/acme/widgets/commit/sha-evidence",
      externalUrl: "https://github.com/acme/widgets/commit/sha-evidence",
      atomicUpdateId: atomic.id,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "pull_request",
      provider: "github",
      externalId: "acme/widgets#42",
      prNumber: 42,
      prTitle: "Add CSV export",
      prUrl: "https://github.com/acme/widgets/pull/42",
      externalUrl: "https://github.com/acme/widgets/pull/42",
      atomicUpdateId: atomic.id,
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });

    const rows = await listAtomicUpdates();
    const row = rows.find((r) => r.id === atomic.id);
    expect(row).toBeDefined();
    expect(row!.events).toEqual([
      {
        id: expect.any(String),
        type: "commit",
        label: "add headers to csv",
        externalUrl: "https://github.com/acme/widgets/commit/sha-evidence",
      },
      {
        id: expect.any(String),
        type: "pull_request",
        label: "Add CSV export",
        externalUrl: "https://github.com/acme/widgets/pull/42",
      },
    ]);
  });

  it("returns a null externalUrl rather than throwing when the change event has none", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const repo = await seedRepo(tenant.id);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Imported fix", summary: "S" })
      .returning();

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-no-url",
      commitSha: "sha-no-url",
      commitMessage: "fix off-by-one",
      // externalUrl intentionally omitted — mirrors imported commits, which
      // never populate this generic column, only the pr/commit-specific one.
      atomicUpdateId: atomic.id,
    });

    const rows = await listAtomicUpdates();
    const row = rows.find((r) => r.id === atomic.id);
    expect(row).toBeDefined();
    expect(row!.events).toEqual([{ id: expect.any(String), type: "commit", label: "fix off-by-one", externalUrl: null }]);
  });

  it("scopes both the atomic updates and their change events to the caller's tenant", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const ownRepo = await seedRepo(tenant.id);
    const foreignRepo = await seedRepo(other.id);

    const [ownAtomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Mine", summary: "S" })
      .returning();
    const [foreignAtomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Theirs", summary: "S" })
      .returning();

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: ownRepo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-mine",
      commitSha: "sha-mine",
      commitMessage: "my change",
      atomicUpdateId: ownAtomic.id,
    });
    await db.insert(changeEvents).values({
      tenantId: other.id,
      repoId: foreignRepo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-theirs",
      commitSha: "sha-theirs",
      commitMessage: "their change",
      atomicUpdateId: foreignAtomic.id,
    });

    currentTenantId = tenant.id;
    const rows = await listAtomicUpdates();

    // Isolation must hold at both levels: the foreign atomic update never
    // appears, and its events (scoped by atomicUpdateId, which is only ever
    // the foreign atomic's id here) don't leak in either. Note this does NOT
    // exercise the events query's own `eq(changeEvents.tenantId, ...)`
    // condition, since foreignAtomic.id is never in the atomicIds list passed
    // to `inArray` in the first place — the atomic-updates query already
    // filtered it out upstream. See the "defends against a data-integrity
    // bug" test below for a case that does exercise that condition.
    expect(rows.map((r) => r.title)).toEqual(["Mine"]);
    const eventLabels = rows.flatMap((r) => r.events.map((e) => e.label));
    expect(eventLabels).toEqual(["my change"]);
    expect(eventLabels).not.toContain("their change");
  });

  it("defends against a data-integrity bug where an event's tenantId disagrees with its atomicUpdateId's owner", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const ownRepo = await seedRepo(tenant.id);

    const [ownAtomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Mine", summary: "S" })
      .returning();

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: ownRepo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-legit",
      commitSha: "sha-legit",
      commitMessage: "legit change",
      atomicUpdateId: ownAtomic.id,
    });
    // Intentionally inconsistent row: atomicUpdateId points at the CALLER's
    // own atomic update (so it passes the `inArray(atomicUpdateId, atomicIds)`
    // filter), but tenantId is the FOREIGN tenant. Normal ingestion never
    // produces this — atomicUpdateId and tenantId are always written together
    // from the same tenant-scoped pipeline — this is constructed directly via
    // insert to prove the events query's own tenantId condition is
    // load-bearing defense-in-depth against exactly that kind of bug, not a
    // reachable path through the resolver.
    await db.insert(changeEvents).values({
      tenantId: other.id,
      repoId: ownRepo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-corrupt",
      commitSha: "sha-corrupt",
      commitMessage: "corrupt cross-tenant change",
      atomicUpdateId: ownAtomic.id,
    });

    currentTenantId = tenant.id;
    const rows = await listAtomicUpdates();

    const row = rows.find((r) => r.id === ownAtomic.id);
    expect(row).toBeDefined();
    const eventLabels = row!.events.map((e) => e.label);
    expect(eventLabels).toEqual(["legit change"]);
    expect(eventLabels).not.toContain("corrupt cross-tenant change");
  });
});

describe("markAtomicUpdateHidden / unhideAtomicUpdate / listHiddenAtomicUpdates", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("flips an open, unlinked atomic update to hidden", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Noisy", summary: "S" })
      .returning();

    const result = await markAtomicUpdateHidden(atomic.id);

    expect(result).toEqual({ ok: true });
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.status).toBe("hidden");
    expect(revalidatePath).toHaveBeenCalledWith("/atomic-updates");
  });

  it("refuses to hide an atomic update that is already released", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Shipped", summary: "S", status: "released" })
      .returning();

    const result = await markAtomicUpdateHidden(atomic.id);

    expect(result).toEqual({ ok: false });
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.status).toBe("released");
  });

  it("refuses to hide an open atomic update already linked to a draft release", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "Draft", body: "B" })
      .returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "In a draft", summary: "S", releaseId: release.id })
      .returning();

    const result = await markAtomicUpdateHidden(atomic.id);

    expect(result).toEqual({ ok: false });
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.status).toBe("open");
    expect(after.releaseId).toBe(release.id);
  });

  it("refuses to hide another tenant's atomic update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [foreign] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S" })
      .returning();
    currentTenantId = tenant.id;

    const result = await markAtomicUpdateHidden(foreign.id);

    expect(result).toEqual({ ok: false });
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreign.id));
    expect(after.status).toBe("open");
  });

  it("flips a hidden atomic update back to open", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Was hidden", summary: "S", status: "hidden" })
      .returning();

    const result = await unhideAtomicUpdate(atomic.id);

    expect(result).toEqual({ ok: true });
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.status).toBe("open");
    expect(revalidatePath).toHaveBeenCalledWith("/atomic-updates");
  });

  it("refuses to unhide an atomic update that is not hidden", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Already open", summary: "S" })
      .returning();

    const result = await unhideAtomicUpdate(atomic.id);

    expect(result).toEqual({ ok: false });
  });

  it("refuses to unhide another tenant's atomic update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [foreign] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign hidden", summary: "S", status: "hidden" })
      .returning();
    currentTenantId = tenant.id;

    const result = await unhideAtomicUpdate(foreign.id);

    expect(result).toEqual({ ok: false });
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreign.id));
    expect(after.status).toBe("hidden");
  });

  it("excludes a hidden atomic update from listAtomicUpdates", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Open", summary: "S" });
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Hidden one", summary: "S", status: "hidden" });

    const rows = await listAtomicUpdates();
    expect(rows.map((r) => r.title)).toEqual(["Open"]);
  });

  it("lists only hidden atomic updates for the tenant, with events populated", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const repo = await seedRepo(tenant.id);
    const [hidden] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Hidden one", summary: "S", status: "hidden" })
      .returning();
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Open one", summary: "S" });
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Shipped one", summary: "S", status: "released" });

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-hidden-evidence",
      commitSha: "sha-hidden-evidence",
      commitMessage: "hidden change",
      atomicUpdateId: hidden.id,
    });

    const rows = await listHiddenAtomicUpdates();

    expect(rows.map((r) => r.title)).toEqual(["Hidden one"]);
    expect(rows[0].events.map((e) => e.label)).toEqual(["hidden change"]);
  });

  it("never leaks another tenant's hidden atomic updates", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign hidden", summary: "S", status: "hidden" });

    const rows = await listHiddenAtomicUpdates();

    expect(rows.map((r) => r.title)).not.toContain("Foreign hidden");
  });

  it("proves the resolver cannot attach a follow-up commit to a hidden atomic update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Still open", summary: "S" });
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Now hidden", summary: "S", status: "hidden" });

    const candidates = await loadOpenAtomicUpdates(db, tenant.id);

    expect(candidates.map((c) => c.title)).toEqual(["Still open"]);
  });
});

describe("listAtomicUpdates filters", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("narrows by category and size, and returns all open updates when unfiltered", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    await db.insert(atomicUpdates).values([
      { tenantId: tenant.id, title: "New S", summary: "S", category: "new", size: "s" },
      { tenantId: tenant.id, title: "Fix L", summary: "S", category: "fix", size: "l" },
      { tenantId: tenant.id, title: "New L", summary: "S", category: "new", size: "l" },
    ]);

    const titles = async (f?: Parameters<typeof listAtomicUpdates>[0]) =>
      (await listAtomicUpdates(f)).map((r) => r.title).sort();

    expect(await titles()).toEqual(["Fix L", "New L", "New S"]);
    expect(await titles({ category: "new" })).toEqual(["New L", "New S"]);
    expect(await titles({ size: "l" })).toEqual(["Fix L", "New L"]);
    expect(await titles({ category: "new", size: "l" })).toEqual(["New L"]);
  });
});

describe("bulkMarkAtomicUpdatesHidden", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("hides every open, unlinked id and reports the count", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const [a] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "A", summary: "S" })
      .returning();
    const [b] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "B", summary: "S" })
      .returning();

    const result = await bulkMarkAtomicUpdatesHidden([a.id, b.id]);

    expect(result).toEqual({ count: 2 });
    const rows = await db.select().from(atomicUpdates).where(eq(atomicUpdates.tenantId, tenant.id));
    expect(rows.every((r) => r.status === "hidden")).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/atomic-updates");
  });

  it("skips released, draft-linked, and foreign ids, counting only the ones actually hidden", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;

    const [open] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Open", summary: "S" })
      .returning();
    const [released] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Released", summary: "S", status: "released" })
      .returning();
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "Draft", body: "B" })
      .returning();
    const [linked] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Linked", summary: "S", releaseId: release.id })
      .returning();
    const [foreign] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S" })
      .returning();

    const result = await bulkMarkAtomicUpdatesHidden([open.id, released.id, linked.id, foreign.id]);

    expect(result).toEqual({ count: 1 });
    const byId = async (id: string) =>
      (await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, id)))[0];
    expect((await byId(open.id)).status).toBe("hidden");
    expect((await byId(released.id)).status).toBe("released");
    expect((await byId(linked.id)).status).toBe("open");
    expect((await byId(foreign.id)).status).toBe("open");
  });

  it("returns count 0 for an empty id list without touching the DB", async () => {
    const result = await bulkMarkAtomicUpdatesHidden([]);
    expect(result).toEqual({ count: 0 });
  });
});

describe("bulkDeleteAtomicUpdates", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("hard-deletes open, unlinked updates and detaches their change events to the unassigned pool", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const repo = await seedRepo(tenant.id);
    const [a] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "A", summary: "S" })
      .returning();
    const [b] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "B", summary: "S" })
      .returning();
    const [event] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        type: "commit",
        provider: "github",
        externalId: "sha-a-evidence",
        commitSha: "sha-a-evidence",
        commitMessage: "evidence for A",
        atomicUpdateId: a.id,
      })
      .returning();

    const result = await bulkDeleteAtomicUpdates([a.id, b.id]);

    expect(result).toEqual({ count: 2 });
    const remaining = await db.select().from(atomicUpdates).where(eq(atomicUpdates.tenantId, tenant.id));
    expect(remaining).toEqual([]);
    // FK is ON DELETE set null: the event survives, now unassigned.
    const [survivingEvent] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(survivingEvent).toBeDefined();
    expect(survivingEvent.atomicUpdateId).toBeNull();
    expect(revalidatePath).toHaveBeenCalledWith("/atomic-updates");
  });

  it("skips released, draft-linked, and foreign ids, deleting only open unlinked ones", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;

    const [open] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Open", summary: "S" })
      .returning();
    const [released] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Released", summary: "S", status: "released" })
      .returning();
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "Draft", body: "B" })
      .returning();
    const [linked] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Linked", summary: "S", releaseId: release.id })
      .returning();
    const [foreign] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S" })
      .returning();

    const result = await bulkDeleteAtomicUpdates([open.id, released.id, linked.id, foreign.id]);

    expect(result).toEqual({ count: 1 });
    const exists = async (id: string) =>
      (await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, id))).length === 1;
    expect(await exists(open.id)).toBe(false);
    expect(await exists(released.id)).toBe(true);
    expect(await exists(linked.id)).toBe(true);
    expect(await exists(foreign.id)).toBe(true);
  });

  it("returns count 0 for an empty id list without touching the DB", async () => {
    const result = await bulkDeleteAtomicUpdates([]);
    expect(result).toEqual({ count: 0 });
  });
});

describe("removeEventFromAtomicUpdate", () => {
  const REMOVE_USER = "remove-evidence-session-user";

  afterEach(async () => {
    vi.mocked(reassignChangeEvent).mockClear();
    vi.mocked(revalidatePath).mockClear();
    currentTenantId = "";
    currentUserId = null;
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("calls reassignChangeEvent with a 'detach' target, forceRegenerate:true, and the session's tenant/user, then revalidates", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Atomic", summary: "S" })
      .returning();
    const [event] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        type: "commit",
        provider: "github",
        externalId: "sha-belongs",
        commitSha: "sha-belongs",
        commitMessage: "belongs to atomic",
        atomicUpdateId: atomic.id,
      })
      .returning();

    currentTenantId = tenant.id;
    currentUserId = REMOVE_USER;

    const result = await removeEventFromAtomicUpdate(atomic.id, event.id);

    expect(reassignChangeEvent).toHaveBeenCalledWith({
      tenantId: tenant.id,
      userId: REMOVE_USER,
      eventId: event.id,
      target: { kind: "detach" },
      confirmEmptyDeletion: undefined,
      forceRegenerate: true,
    });
    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/atomic-updates");
  });

  it("passes confirmEmptyDeletion through when removing the last event", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Atomic", summary: "S" })
      .returning();
    const [event] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        type: "commit",
        provider: "github",
        externalId: "sha-last",
        commitSha: "sha-last",
        commitMessage: "last one",
        atomicUpdateId: atomic.id,
      })
      .returning();

    currentTenantId = tenant.id;
    currentUserId = REMOVE_USER;

    await removeEventFromAtomicUpdate(atomic.id, event.id, true);

    expect(reassignChangeEvent).toHaveBeenCalledWith({
      tenantId: tenant.id,
      userId: REMOVE_USER,
      eventId: event.id,
      target: { kind: "detach" },
      confirmEmptyDeletion: true,
      forceRegenerate: true,
    });
  });

  it("rejects without calling the core when the event does not belong to the given atomic update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);
    const [actualAtomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Actual", summary: "S" })
      .returning();
    const [otherAtomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Other", summary: "S" })
      .returning();
    const [event] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        type: "commit",
        provider: "github",
        externalId: "sha-mismatch",
        commitSha: "sha-mismatch",
        commitMessage: "elsewhere",
        atomicUpdateId: actualAtomic.id,
      })
      .returning();

    currentTenantId = tenant.id;
    currentUserId = REMOVE_USER;

    const result = await removeEventFromAtomicUpdate(otherAtomic.id, event.id);

    expect(result).toEqual({ ok: false, reason: "Change event does not belong to this atomic update." });
    expect(reassignChangeEvent).not.toHaveBeenCalled();
  });

  it("rejects a nonexistent event without calling the core", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Atomic", summary: "S" })
      .returning();

    currentTenantId = tenant.id;
    currentUserId = REMOVE_USER;

    const result = await removeEventFromAtomicUpdate(atomic.id, "00000000-0000-0000-0000-000000000099");

    expect(result).toEqual({ ok: false, reason: "Change event does not belong to this atomic update." });
    expect(reassignChangeEvent).not.toHaveBeenCalled();
  });

  it("rejects a cross-tenant event without calling the core", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const foreignRepo = await seedRepo(other.id);
    const [foreignAtomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S" })
      .returning();
    const [foreignEvent] = await db
      .insert(changeEvents)
      .values({
        tenantId: other.id,
        repoId: foreignRepo.id,
        type: "commit",
        provider: "github",
        externalId: "sha-foreign-remove",
        commitSha: "sha-foreign-remove",
        commitMessage: "foreign change",
        atomicUpdateId: foreignAtomic.id,
      })
      .returning();

    currentTenantId = tenant.id;
    currentUserId = REMOVE_USER;

    const result = await removeEventFromAtomicUpdate(foreignAtomic.id, foreignEvent.id);

    expect(result).toEqual({ ok: false, reason: "Change event does not belong to this atomic update." });
    expect(reassignChangeEvent).not.toHaveBeenCalled();
  });
});

describe("setAtomicUpdateSize / setAtomicUpdateCategory", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("setAtomicUpdateSize writes the size and freezes it, tenant+open scoped", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const [au] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "T", summary: "S", status: "open" })
      .returning();

    const res = await setAtomicUpdateSize(au.id, "l");

    expect(res.ok).toBe(true);
    const [row] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, au.id));
    expect(row.size).toBe("l");
    expect(row.sizeEditedAt).not.toBeNull();
  });

  it("setAtomicUpdateSize refuses a released or other-tenant update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;

    const [released] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Released", summary: "S", status: "released" })
      .returning();
    const [foreign] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S", status: "open" })
      .returning();

    const releasedResult = await setAtomicUpdateSize(released.id, "l");
    const foreignResult = await setAtomicUpdateSize(foreign.id, "l");

    expect(releasedResult).toEqual({ ok: false });
    expect(foreignResult).toEqual({ ok: false });
    const [releasedAfter] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, released.id));
    const [foreignAfter] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreign.id));
    expect(releasedAfter.size).toBeNull();
    expect(foreignAfter.size).toBeNull();
  });

  it("setAtomicUpdateCategory writes the category (no freeze), tenant+open scoped", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const [au] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "T", summary: "S", status: "open" })
      .returning();

    const res = await setAtomicUpdateCategory(au.id, "fix");

    expect(res.ok).toBe(true);
    const [row] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, au.id));
    expect(row.category).toBe("fix");
    expect(row.sizeEditedAt).toBeNull();
  });

  it("setAtomicUpdateCategory refuses a released or other-tenant update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;

    const [released] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Released", summary: "S", status: "released" })
      .returning();
    const [foreign] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S", status: "open" })
      .returning();

    const releasedResult = await setAtomicUpdateCategory(released.id, "fix");
    const foreignResult = await setAtomicUpdateCategory(foreign.id, "fix");

    expect(releasedResult).toEqual({ ok: false });
    expect(foreignResult).toEqual({ ok: false });
    const [releasedAfter] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, released.id));
    const [foreignAfter] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreign.id));
    expect(releasedAfter.category).toBeNull();
    expect(foreignAfter.category).toBeNull();
  });
});
