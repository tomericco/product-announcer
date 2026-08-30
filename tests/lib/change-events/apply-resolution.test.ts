import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, atomicUpdates, contentPieces } from "../../../src/db/schema";
import { seedTenant, dropTenant } from "../../helpers/fixtures";
import {
  applyResolution,
  loadOpenAtomicUpdates,
  withTenantLock,
  titlesMatch,
  MAX_OPEN_CANDIDATES,
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
    await dropTenant("Candidate Cap Tenant");
    await dropTenant("Candidate Exemption Tenant");
  });

  it("creates an atomic update and attaches the event", async () => {
    const { tenant, repo } = await seed();
    const event = await insertEvent(tenant.id, repo.id, "sha-create");

    await applyResolution(db, tenant.id, [
      { eventId: event.id, action: "create", title: "CSV export", summary: "Export as CSV.", category: "new", size: "m" },
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
      { eventId: first.id, action: "create", title: "CSV export", summary: "Export as CSV.", category: "new", size: "m" },
      { eventId: second.id, action: "create", title: "CSV Export", summary: "Export as CSV.", category: "new", size: "m" },
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
    const foreign = await insertEvent(other.id, otherRepo.id, "sha-foreign");

    await applyResolution(db, tenant.id, [
      { eventId: foreign.id, action: "create", title: "X", summary: "Y", category: "new", size: "m" },
    ]);

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, foreign.id));
    expect(updated.atomicUpdateId).toBeNull();
  });

  it("never assigns to an atomic update owned by another tenant", async () => {
    const { tenant, repo } = await seed();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [foreignAtomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S" })
      .returning();
    const event = await insertEvent(tenant.id, repo.id, "sha-cross-tenant-assign");

    await applyResolution(db, tenant.id, [
      { eventId: event.id, action: "assign", atomicUpdateId: foreignAtomic.id },
    ]);

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).toBeNull();

    const [otherAtomic] = await db
      .select()
      .from(atomicUpdates)
      .where(eq(atomicUpdates.id, foreignAtomic.id));
    expect(otherAtomic.tenantId).toBe(other.id);
  });

  it("never assigns an event to an atomic update already released mid-resolution", async () => {
    const { tenant, repo } = await seed();
    const [released] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Shipped", summary: "S", status: "released" })
      .returning();
    const event = await insertEvent(tenant.id, repo.id, "sha-assign-released");

    await applyResolution(db, tenant.id, [
      { eventId: event.id, action: "assign", atomicUpdateId: released.id },
    ]);

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).toBeNull();
  });

  it("never assigns an excluded (detached) event, even if targeted by id (Finding 3)", async () => {
    const { tenant, repo } = await seed();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "CSV export", summary: "Export as CSV." })
      .returning();
    const event = await insertEvent(tenant.id, repo.id, "sha-excluded");
    await db
      .update(changeEvents)
      .set({ status: "excluded", excludedAt: new Date() })
      .where(eq(changeEvents.id, event.id));

    await applyResolution(db, tenant.id, [
      { eventId: event.id, action: "assign", atomicUpdateId: atomic.id },
    ]);

    const [afterAssign] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(afterAssign.atomicUpdateId).toBeNull();
    expect(afterAssign.status).toBe("excluded");

    await applyResolution(db, tenant.id, [
      { eventId: event.id, action: "create", title: "X", summary: "Y", category: "new", size: "m" },
    ]);

    const [afterCreate] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(afterCreate.atomicUpdateId).toBeNull();
    expect(afterCreate.status).toBe("excluded");
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
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "Draft", body: "B" })
      .returning();
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "In a draft", summary: "S", contentPieceId: release.id });

    const open = await loadOpenAtomicUpdates(db, tenant.id);
    expect(open.map((a) => a.title)).toContain("In a draft");
  });

  it("caps the candidate set at MAX_OPEN_CANDIDATES", async () => {
    const tenant = await seedTenant("Candidate Cap Tenant");
    for (let i = 0; i < MAX_OPEN_CANDIDATES + 5; i++) {
      await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: `AU ${i}`, summary: "s" });
    }
    const open = await loadOpenAtomicUpdates(db, tenant.id);
    expect(open.length).toBe(MAX_OPEN_CANDIDATES);
  });

  it("includes a draft-linked update even when the cap would exclude it", async () => {
    const tenant = await seedTenant("Candidate Exemption Tenant");
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "Draft", body: "b", status: "draft" })
      .returning();
    // Oldest by updatedAt, so recency ordering alone would drop it.
    const [linked] = await db
      .insert(atomicUpdates)
      .values({
        tenantId: tenant.id,
        title: "Linked to a draft",
        summary: "s",
        contentPieceId: piece.id,
        updatedAt: new Date("2020-01-01T00:00:00Z"),
      })
      .returning();
    for (let i = 0; i < MAX_OPEN_CANDIDATES + 5; i++) {
      await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: `AU ${i}`, summary: "s" });
    }

    const open = await loadOpenAtomicUpdates(db, tenant.id);
    expect(open.map((a) => a.id)).toContain(linked.id);
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

describe("titlesMatch", () => {
  it("matches identical titles", () => {
    expect(titlesMatch("Shared dashboards", "Shared dashboards")).toBe(true);
  });

  it("matches across case, punctuation and spacing", () => {
    expect(titlesMatch("Shared Dashboards!", "  shared   dashboards ")).toBe(true);
  });

  // "dashboards" and "dashboard" are different tokens: "shared" is the only
  // token in common, so the symmetric difference is 2 (drops "dashboards",
  // adds "dashboard") — over the MAX_TITLE_TOKEN_DIFFERENCE of 1, so this does
  // not merge. That is the honest outcome of the chosen algorithm, not a bug:
  // merging two genuinely different atomic updates is a worse failure than
  // leaving two near-duplicates unmerged, so the bound is not tuned to catch
  // this case.
  it("does not merge a singular/plural near-miss — symmetric difference is 2", () => {
    expect(titlesMatch("Shared dashboards", "Shared dashboard")).toBe(false);
  });

  it("matches a title differing only by a stray extra word", () => {
    expect(titlesMatch("New shared dashboards for teams", "Shared dashboards for teams")).toBe(true);
  });

  it("does NOT match two genuinely different changes", () => {
    expect(titlesMatch("Shared dashboards", "CSV export")).toBe(false);
    expect(titlesMatch("Faster search", "Faster export")).toBe(false);
  });

  // The whole point of the symmetric-difference rewrite: a one-word
  // difference merges the same way regardless of title length, unlike the
  // old Jaccard threshold which only fired on longer titles.
  it("merges a one-word difference on a short title (2 vs 3 tokens)", () => {
    expect(titlesMatch("Faster search", "Much faster search")).toBe(true);
  });

  it("merges a one-word difference on a long title (8 vs 9 tokens)", () => {
    expect(
      titlesMatch(
        "One two three four five six seven eight",
        "One two three four five six seven eight nine"
      )
    ).toBe(true);
  });

  // Without the MIN_TITLE_TOKENS guard, a single-token title would be
  // subsumed by any longer title that contains it as a substring of tokens —
  // symmetric difference here is 1, but "Search" is not the same change as
  // "Faster search".
  it("does not merge a one-token title into a longer title that contains it", () => {
    expect(titlesMatch("Search", "Faster search")).toBe(false);
  });

  // Regression: the MIN_TITLE_TOKENS guard used to run BEFORE the exact-match
  // check, so it rejected two identical one-word titles before the equality
  // check ever ran — a two-word resolver batch that correctly gave two events
  // the same one-word title ("Autosave", "Webhooks", "SSO", "Undo") would then
  // create two atomic updates for one change. Equal token sets must be checked
  // first, regardless of size.
  it("merges identical one-token titles", () => {
    expect(titlesMatch("Autosave", "Autosave")).toBe(true);
    expect(titlesMatch("Autosave", "  AUTOSAVE ")).toBe(true);
  });

  it("still merges identical multi-token titles", () => {
    expect(titlesMatch("Shared dashboards", "Shared dashboards")).toBe(true);
  });

  // Two different emoji-only titles both normalize to an empty token set —
  // merging them just because neither has any text would be an accidental
  // merge, so this predicate falls back to exact string equality instead of
  // treating "both empty" as a match.
  it("does not merge two different emoji-only titles", () => {
    expect(titlesMatch("🎉", "🚀")).toBe(false);
  });

  it("merges two identical emoji-only titles", () => {
    expect(titlesMatch("🎉", "🎉")).toBe(true);
    expect(titlesMatch(" 🎉 ", "🎉")).toBe(true);
  });
});
