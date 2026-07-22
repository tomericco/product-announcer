import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeEvents, atomicUpdates } from "../../src/db/schema";

const TENANT = "Atomic Updates Actions Test Tenant";
let currentTenantId = "";

// requireSession() returns a NextAuth Session (tenantId lives under `user`,
// per src/types/next-auth.d.ts) — mirror that shape rather than a flat one,
// so the mock matches what the real module actually returns.
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: null } })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { editAtomicUpdate, listAtomicUpdates } from "../../src/app/(dashboard)/atomic-updates/actions";

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
