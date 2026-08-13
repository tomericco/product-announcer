import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, atomicUpdates, contentPieces } from "../../../src/db/schema";

const TENANT = "Atomic Updates Actions Test Tenant";

// removeEventFromAtomicUpdate only orchestrates: build the reassign target,
// force regen on, and call the core. The core's own transactional behavior
// (moving/detaching, the empty-source confirmation gate, the
// released-frozen guard, and — load-bearing for this task — the
// forceRegenerate freeze-clear) is covered by
// tests/lib/change-events/reassign.test.ts with a stubbed `refresh`. Mocking
// it here keeps this test from touching the real regeneration path, which
// would otherwise reach the live Anthropic API per the task's hard
// constraint.
vi.mock("../../../src/lib/change-events/reassign", () => ({
  reassignChangeEvent: vi.fn(async () => ({ ok: true })),
}));

import {
  editAtomicUpdate,
  listAtomicUpdates,
  hideAtomicUpdate,
  bulkHideAtomicUpdates,
  bulkDeleteAtomicUpdates,
  unhideAtomicUpdate,
  hasCuratableAtomicUpdates,
  removeEventFromAtomicUpdate,
  setAtomicUpdateSize,
  setAtomicUpdateCategory,
} from "../../../src/lib/atomic-updates/list";
import { reassignChangeEvent } from "../../../src/lib/change-events/reassign";
import { loadOpenAtomicUpdates } from "../../../src/lib/change-events/apply-resolution";

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
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Open", summary: "S" });
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Shipped", summary: "S", status: "released" });

    const rows = await listAtomicUpdates(tenant.id);
    expect(rows.map((r) => r.title)).toEqual(["Open"]);
  });

  it("excludes an open atomic update already linked to a draft release", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [release] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "Draft", body: "B" })
      .returning();
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Open, unclaimed", summary: "S" });
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Open, but in a draft", summary: "S", contentPieceId: release.id });

    const rows = await listAtomicUpdates(tenant.id);
    expect(rows.map((r) => r.title)).toEqual(["Open, unclaimed"]);
  });

  it("sets summaryEditedAt when edited, freezing regeneration", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Before", summary: "Before summary." })
      .returning();

    await editAtomicUpdate(tenant.id, atomic.id, { title: "After", summary: "After summary." });

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

    await editAtomicUpdate(tenant.id, foreign.id, { title: "Hacked", summary: "Hacked." });

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreign.id));
    expect(after.title).toBe("Foreign");
  });

  it("returns each atomic update's change events with the right labels and urls", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
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

    const rows = await listAtomicUpdates(tenant.id);
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

  // Regression: the label chain used to read prTitle for anything that wasn't
  // a commit, and a Notion task stores its title in taskTitle — so task
  // evidence came back with label "" and the card rendered a row that showed
  // nothing but its type chip.
  it("labels task evidence from taskTitle", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Task-backed", summary: "S" })
      .returning();

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: null,
      type: "task",
      provider: "notion",
      externalId: "notion-page-1",
      externalUrl: "https://notion.so/page-1",
      taskTitle: "Ship the CSV exporter",
      atomicUpdateId: atomic.id,
    });

    const rows = await listAtomicUpdates(tenant.id);
    const row = rows.find((r) => r.id === atomic.id);
    expect(row!.events).toEqual([
      {
        id: expect.any(String),
        type: "task",
        label: "Ship the CSV exporter",
        externalUrl: "https://notion.so/page-1",
      },
    ]);
  });

  it("falls back to Untitled rather than an empty evidence label", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Titleless evidence", summary: "S" })
      .returning();

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: null,
      type: "task",
      provider: "notion",
      externalId: "notion-page-untitled",
      // No taskTitle/prTitle at all — the row must still be visible and
      // clickable on the card, which an empty label would prevent.
      atomicUpdateId: atomic.id,
    });

    const rows = await listAtomicUpdates(tenant.id);
    const row = rows.find((r) => r.id === atomic.id);
    expect(row!.events[0].label).toBe("Untitled");
  });

  it("returns a null externalUrl rather than throwing when the change event has none", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
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

    const rows = await listAtomicUpdates(tenant.id);
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

    const rows = await listAtomicUpdates(tenant.id);

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

    const rows = await listAtomicUpdates(tenant.id);

    const row = rows.find((r) => r.id === ownAtomic.id);
    expect(row).toBeDefined();
    const eventLabels = row!.events.map((e) => e.label);
    expect(eventLabels).toEqual(["legit change"]);
    expect(eventLabels).not.toContain("corrupt cross-tenant change");
  });
});

describe("hideAtomicUpdate / unhideAtomicUpdate / showHidden listing", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("flips an open, unlinked atomic update to hidden", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Noisy", summary: "S" })
      .returning();

    const result = await hideAtomicUpdate(tenant.id, atomic.id);

    expect(result).toEqual({ ok: true });
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.status).toBe("hidden");
  });

  it("refuses to hide an atomic update that is already released", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Shipped", summary: "S", status: "released" })
      .returning();

    const result = await hideAtomicUpdate(tenant.id, atomic.id);

    expect(result).toEqual({ ok: false });
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.status).toBe("released");
  });

  it("refuses to hide an open atomic update already linked to a draft release", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [release] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "Draft", body: "B" })
      .returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "In a draft", summary: "S", contentPieceId: release.id })
      .returning();

    const result = await hideAtomicUpdate(tenant.id, atomic.id);

    expect(result).toEqual({ ok: false });
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.status).toBe("open");
    expect(after.contentPieceId).toBe(release.id);
  });

  it("refuses to hide another tenant's atomic update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [foreign] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S" })
      .returning();

    const result = await hideAtomicUpdate(tenant.id, foreign.id);

    expect(result).toEqual({ ok: false });
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreign.id));
    expect(after.status).toBe("open");
  });

  it("flips a hidden atomic update back to open", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Was hidden", summary: "S", status: "hidden" })
      .returning();

    const result = await unhideAtomicUpdate(tenant.id, atomic.id);

    expect(result).toEqual({ ok: true });
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.status).toBe("open");
  });

  it("refuses to unhide an atomic update that is not hidden", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Already open", summary: "S" })
      .returning();

    const result = await unhideAtomicUpdate(tenant.id, atomic.id);

    expect(result).toEqual({ ok: false });
  });

  it("refuses to unhide another tenant's atomic update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [foreign] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign hidden", summary: "S", status: "hidden" })
      .returning();

    const result = await unhideAtomicUpdate(tenant.id, foreign.id);

    expect(result).toEqual({ ok: false });
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreign.id));
    expect(after.status).toBe("hidden");
  });

  it("excludes a hidden atomic update from listAtomicUpdates by default", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Open", summary: "S" });
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Hidden one", summary: "S", status: "hidden" });

    const rows = await listAtomicUpdates(tenant.id);
    expect(rows.map((r) => r.title)).toEqual(["Open"]);
  });

  // The inline treatment: showHidden folds hidden updates into the SAME result
  // set as the open ones (ordered by createdAt, not segregated), each carrying
  // the `hidden` flag the card reads to render itself dashed and read-only.
  it("returns hidden updates inline with the open ones under showHidden, flagged and with events", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);
    // Explicit createdAt: these are inserted in the same statement batch, and
    // the assertion below is about the interleaved ORDER, which needs the two
    // rows to be genuinely distinguishable by the sort key.
    const [hidden] = await db
      .insert(atomicUpdates)
      .values({
        tenantId: tenant.id,
        title: "Hidden one",
        summary: "S",
        status: "hidden",
        createdAt: new Date("2026-03-02T00:00:00Z"),
      })
      .returning();
    await db.insert(atomicUpdates).values({
      tenantId: tenant.id,
      title: "Open newer",
      summary: "S",
      createdAt: new Date("2026-03-03T00:00:00Z"),
    });
    await db.insert(atomicUpdates).values({
      tenantId: tenant.id,
      title: "Open older",
      summary: "S",
      createdAt: new Date("2026-03-01T00:00:00Z"),
    });
    // A released update stays out either way — showHidden widens the status
    // filter to open+hidden, nothing more.
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

    const rows = await listAtomicUpdates(tenant.id, { showHidden: true });

    expect(rows.map((r) => r.title)).toEqual(["Open newer", "Hidden one", "Open older"]);
    expect(rows.map((r) => r.hidden)).toEqual([false, true, false]);
    const hiddenRow = rows.find((r) => r.title === "Hidden one");
    expect(hiddenRow!.events.map((e) => e.label)).toEqual(["hidden change"]);
  });

  it("applies the category filter to hidden updates too", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Hidden fix", summary: "S", status: "hidden", category: "fix" });
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Hidden new", summary: "S", status: "hidden", category: "new" });

    const rows = await listAtomicUpdates(tenant.id, { showHidden: true, category: "fix" });

    expect(rows.map((r) => r.title)).toEqual(["Hidden fix"]);
  });

  it("never leaks another tenant's hidden atomic updates", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign hidden", summary: "S", status: "hidden" });

    const rows = await listAtomicUpdates(tenant.id, { showHidden: true });

    expect(rows.map((r) => r.title)).not.toContain("Foreign hidden");
  });

  it("proves the resolver cannot attach a follow-up commit to a hidden atomic update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
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
    await db.insert(atomicUpdates).values([
      { tenantId: tenant.id, title: "New S", summary: "S", category: "new", size: "s" },
      { tenantId: tenant.id, title: "Fix L", summary: "S", category: "fix", size: "l" },
      { tenantId: tenant.id, title: "New L", summary: "S", category: "new", size: "l" },
    ]);

    const titles = async (f?: Parameters<typeof listAtomicUpdates>[1]) =>
      (await listAtomicUpdates(tenant.id, f)).map((r) => r.title).sort();

    expect(await titles()).toEqual(["Fix L", "New L", "New S"]);
    expect(await titles({ category: "new" })).toEqual(["New L", "New S"]);
    expect(await titles({ size: "l" })).toEqual(["Fix L", "New L"]);
    expect(await titles({ category: "new", size: "l" })).toEqual(["New L"]);
  });
});

// Guards the page's onboarding empty state. The hidden case is the reason this
// exists: `listAtomicUpdates()` alone can't distinguish "brand-new workspace"
// from "everything here is hidden", and showing the onboarding state for the
// latter would hide the filter bar that reaches those updates.
describe("hasCuratableAtomicUpdates", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("is false for a workspace with no atomic updates", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();

    expect(await hasCuratableAtomicUpdates(tenant.id)).toBe(false);
  });

  it("is true when the only atomic update is hidden", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Hidden only", summary: "S", status: "hidden" });

    expect(await hasCuratableAtomicUpdates(tenant.id)).toBe(true);
  });

  it("is false when every atomic update is released or claimed by a draft", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [release] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "Draft", body: "B" })
      .returning();
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Shipped", summary: "S", status: "released" });
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Claimed", summary: "S", contentPieceId: release.id });

    expect(await hasCuratableAtomicUpdates(tenant.id)).toBe(false);
  });

  it("is false for another tenant's atomic updates", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db.insert(atomicUpdates).values({ tenantId: other.id, title: "Foreign", summary: "S" });

    expect(await hasCuratableAtomicUpdates(tenant.id)).toBe(false);
  });
});

describe("bulkHideAtomicUpdates", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("hides every open, unlinked id and reports the count", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "A", summary: "S" })
      .returning();
    const [b] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "B", summary: "S" })
      .returning();

    const result = await bulkHideAtomicUpdates(tenant.id, [a.id, b.id]);

    expect(result).toEqual({ count: 2 });
    const rows = await db.select().from(atomicUpdates).where(eq(atomicUpdates.tenantId, tenant.id));
    expect(rows.every((r) => r.status === "hidden")).toBe(true);
  });

  it("skips released, draft-linked, and foreign ids, counting only the ones actually hidden", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();

    const [open] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Open", summary: "S" })
      .returning();
    const [released] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Released", summary: "S", status: "released" })
      .returning();
    const [release] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "Draft", body: "B" })
      .returning();
    const [linked] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Linked", summary: "S", contentPieceId: release.id })
      .returning();
    const [foreign] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S" })
      .returning();

    const result = await bulkHideAtomicUpdates(tenant.id, [open.id, released.id, linked.id, foreign.id]);

    expect(result).toEqual({ count: 1 });
    const byId = async (id: string) =>
      (await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, id)))[0];
    expect((await byId(open.id)).status).toBe("hidden");
    expect((await byId(released.id)).status).toBe("released");
    expect((await byId(linked.id)).status).toBe("open");
    expect((await byId(foreign.id)).status).toBe("open");
  });

  it("returns count 0 for an empty id list without touching the DB", async () => {
    const result = await bulkHideAtomicUpdates("nonexistent-tenant", []);
    expect(result).toEqual({ count: 0 });
  });
});

describe("bulkDeleteAtomicUpdates", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("hard-deletes open, unlinked updates and detaches their change events to the unassigned pool", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
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

    const result = await bulkDeleteAtomicUpdates(tenant.id, [a.id, b.id]);

    expect(result).toEqual({ count: 2 });
    const remaining = await db.select().from(atomicUpdates).where(eq(atomicUpdates.tenantId, tenant.id));
    expect(remaining).toEqual([]);
    // FK is ON DELETE set null: the event survives, now unassigned.
    const [survivingEvent] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(survivingEvent).toBeDefined();
    expect(survivingEvent.atomicUpdateId).toBeNull();
  });

  it("skips released, draft-linked, and foreign ids, deleting only open unlinked ones", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();

    const [open] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Open", summary: "S" })
      .returning();
    const [released] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Released", summary: "S", status: "released" })
      .returning();
    const [release] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "Draft", body: "B" })
      .returning();
    const [linked] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Linked", summary: "S", contentPieceId: release.id })
      .returning();
    const [foreign] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S" })
      .returning();

    const result = await bulkDeleteAtomicUpdates(tenant.id, [open.id, released.id, linked.id, foreign.id]);

    expect(result).toEqual({ count: 1 });
    const exists = async (id: string) =>
      (await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, id))).length === 1;
    expect(await exists(open.id)).toBe(false);
    expect(await exists(released.id)).toBe(true);
    expect(await exists(linked.id)).toBe(true);
    expect(await exists(foreign.id)).toBe(true);
  });

  it("returns count 0 for an empty id list without touching the DB", async () => {
    const result = await bulkDeleteAtomicUpdates("nonexistent-tenant", []);
    expect(result).toEqual({ count: 0 });
  });
});

describe("removeEventFromAtomicUpdate", () => {
  const REMOVE_USER = "remove-evidence-session-user";

  afterEach(async () => {
    vi.mocked(reassignChangeEvent).mockClear();
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("calls reassignChangeEvent with a 'detach' target, forceRegenerate:true, and the given tenant/user", async () => {
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

    const result = await removeEventFromAtomicUpdate({
      tenantId: tenant.id,
      userId: REMOVE_USER,
      atomicUpdateId: atomic.id,
      eventId: event.id,
    });

    expect(reassignChangeEvent).toHaveBeenCalledWith({
      tenantId: tenant.id,
      userId: REMOVE_USER,
      eventId: event.id,
      target: { kind: "detach" },
      confirmEmptyDeletion: undefined,
      forceRegenerate: true,
    });
    expect(result).toEqual({ ok: true });
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

    await removeEventFromAtomicUpdate({
      tenantId: tenant.id,
      userId: REMOVE_USER,
      atomicUpdateId: atomic.id,
      eventId: event.id,
      confirmEmptyDeletion: true,
    });

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

    const result = await removeEventFromAtomicUpdate({
      tenantId: tenant.id,
      userId: REMOVE_USER,
      atomicUpdateId: otherAtomic.id,
      eventId: event.id,
    });

    expect(result).toEqual({ ok: false, reason: "Change event does not belong to this atomic update." });
    expect(reassignChangeEvent).not.toHaveBeenCalled();
  });

  it("rejects a nonexistent event without calling the core", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Atomic", summary: "S" })
      .returning();

    const result = await removeEventFromAtomicUpdate({
      tenantId: tenant.id,
      userId: REMOVE_USER,
      atomicUpdateId: atomic.id,
      eventId: "00000000-0000-0000-0000-000000000099",
    });

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

    const result = await removeEventFromAtomicUpdate({
      tenantId: tenant.id,
      userId: REMOVE_USER,
      atomicUpdateId: foreignAtomic.id,
      eventId: foreignEvent.id,
    });

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
    const [au] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "T", summary: "S", status: "open" })
      .returning();

    const res = await setAtomicUpdateSize(tenant.id, au.id, "l");

    expect(res.ok).toBe(true);
    const [row] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, au.id));
    expect(row.size).toBe("l");
    expect(row.sizeEditedAt).not.toBeNull();
  });

  it("setAtomicUpdateSize refuses a released or other-tenant update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();

    const [released] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Released", summary: "S", status: "released" })
      .returning();
    const [foreign] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S", status: "open" })
      .returning();

    const releasedResult = await setAtomicUpdateSize(tenant.id, released.id, "l");
    const foreignResult = await setAtomicUpdateSize(tenant.id, foreign.id, "l");

    expect(releasedResult).toEqual({ ok: false });
    expect(foreignResult).toEqual({ ok: false });
    const [releasedAfter] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, released.id));
    const [foreignAfter] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreign.id));
    expect(releasedAfter.size).toBeNull();
    expect(foreignAfter.size).toBeNull();
  });

  it("setAtomicUpdateCategory writes the category (no freeze), tenant+open scoped", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [au] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "T", summary: "S", status: "open" })
      .returning();

    const res = await setAtomicUpdateCategory(tenant.id, au.id, "fix");

    expect(res.ok).toBe(true);
    const [row] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, au.id));
    expect(row.category).toBe("fix");
    expect(row.sizeEditedAt).toBeNull();
  });

  it("setAtomicUpdateCategory refuses a released or other-tenant update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();

    const [released] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Released", summary: "S", status: "released" })
      .returning();
    const [foreign] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S", status: "open" })
      .returning();

    const releasedResult = await setAtomicUpdateCategory(tenant.id, released.id, "fix");
    const foreignResult = await setAtomicUpdateCategory(tenant.id, foreign.id, "fix");

    expect(releasedResult).toEqual({ ok: false });
    expect(foreignResult).toEqual({ ok: false });
    const [releasedAfter] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, released.id));
    const [foreignAfter] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreign.id));
    expect(releasedAfter.category).toBeNull();
    expect(foreignAfter.category).toBeNull();
  });
});
