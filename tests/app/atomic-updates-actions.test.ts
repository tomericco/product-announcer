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

// createFromEvents only orchestrates: derive tenant/user from the (mocked)
// session, parse eventIds/confirmEmptyDeletion off formData, call the core,
// and revalidate. The core's own transactional behavior (moving events,
// the empty-source confirmation gate, the released-frozen guard) is covered
// by tests/lib/change-events/create-from-events.test.ts — mocking it here
// keeps this test from touching Postgres for that path and, per the task's
// hard constraint, never reaches the live Anthropic API.
vi.mock("../../src/lib/change-events/create-from-events", () => ({
  createAtomicUpdateFromEvents: vi.fn(async () => ({ ok: true, atomicUpdateId: "au-x" })),
}));

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

// addEventsToAtomicUpdate only orchestrates: derive tenant/user from the
// (mocked) session, call the batch core, and revalidate. The core's own
// transactional behavior (moving multiple events in one transaction, the
// single post-commit regeneration, the empty-source confirmation gate, the
// released-frozen guard) is covered by
// tests/lib/change-events/add-events-to-atomic-update.test.ts with a stubbed
// `refresh`. Mocking it here keeps this test from touching the real
// regeneration path, which would otherwise reach the live Anthropic API per
// the task's hard constraint.
vi.mock("../../src/lib/change-events/add-events-to-atomic-update", () => ({
  addEventsToExistingAtomicUpdate: vi.fn(async () => ({ ok: true })),
}));

import {
  editAtomicUpdate,
  listAtomicUpdates,
  listSelectableEvents,
  createFromEvents,
  markAtomicUpdateHidden,
  unhideAtomicUpdate,
  listHiddenAtomicUpdates,
  addEventsToAtomicUpdate,
  removeEventFromAtomicUpdate,
} from "../../src/app/(dashboard)/atomic-updates/actions";
import { createAtomicUpdateFromEvents } from "../../src/lib/change-events/create-from-events";
import { reassignChangeEvent } from "../../src/lib/change-events/reassign";
import { addEventsToExistingAtomicUpdate } from "../../src/lib/change-events/add-events-to-atomic-update";
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

describe("listSelectableEvents", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("includes an unassigned event and an event in an OPEN atomic update, but excludes one in a RELEASED atomic update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const repo = await seedRepo(tenant.id);
    const [openAtomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Open one", summary: "S" })
      .returning();
    const [releasedAtomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Released one", summary: "S", status: "released" })
      .returning();

    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-unassigned",
      commitSha: "sha-unassigned",
      commitMessage: "unassigned change",
    });
    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "pull_request",
      provider: "github",
      externalId: "acme/widgets#7",
      prNumber: 7,
      prTitle: "In an open atomic update",
      atomicUpdateId: openAtomic.id,
    });
    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      repoId: repo.id,
      type: "pull_request",
      provider: "github",
      externalId: "acme/widgets#8",
      prNumber: 8,
      prTitle: "In a released atomic update",
      atomicUpdateId: releasedAtomic.id,
    });

    const rows = await listSelectableEvents();
    const titles = rows.map((r) => r.title);

    expect(titles).toContain("unassigned change");
    expect(titles).toContain("In an open atomic update");
    expect(titles).not.toContain("In a released atomic update");

    const assignedRow = rows.find((r) => r.title === "In an open atomic update");
    expect(assignedRow?.atomicUpdateId).toBe(openAtomic.id);
    expect(assignedRow?.atomicUpdateTitle).toBe("Open one");

    const unassignedRow = rows.find((r) => r.title === "unassigned change");
    expect(unassignedRow?.atomicUpdateId).toBeNull();
    expect(unassignedRow?.atomicUpdateTitle).toBeNull();
  });

  it("never leaks another tenant's change events", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const foreignRepo = await seedRepo(other.id);

    await db.insert(changeEvents).values({
      tenantId: other.id,
      repoId: foreignRepo.id,
      type: "commit",
      provider: "github",
      externalId: "sha-foreign",
      commitSha: "sha-foreign",
      commitMessage: "their unassigned change",
    });

    const rows = await listSelectableEvents();
    expect(rows.map((r) => r.title)).not.toContain("their unassigned change");
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

describe("createFromEvents", () => {
  const AU_TENANT = "au-session-tenant";
  const AU_USER = "au-session-user";

  afterEach(() => {
    vi.mocked(createAtomicUpdateFromEvents).mockClear();
    vi.mocked(revalidatePath).mockClear();
    currentTenantId = "";
    currentUserId = null;
  });

  it("calls createAtomicUpdateFromEvents with the session's tenantId/userId and the parsed eventIds/confirmEmptyDeletion, then revalidates", async () => {
    currentTenantId = AU_TENANT;
    currentUserId = AU_USER;

    const formData = new FormData();
    formData.append("eventIds", "event-1");
    formData.append("eventIds", "event-2");

    const result = await createFromEvents(formData);

    expect(createAtomicUpdateFromEvents).toHaveBeenCalledWith({
      tenantId: AU_TENANT,
      userId: AU_USER,
      eventIds: ["event-1", "event-2"],
      confirmEmptyDeletion: false,
    });
    expect(result).toEqual({ ok: true, atomicUpdateId: "au-x" });
    expect(revalidatePath).toHaveBeenCalledWith("/atomic-updates");
  });

  it("parses confirmEmptyDeletion=true when the field is set to 'true'", async () => {
    currentTenantId = AU_TENANT;
    currentUserId = AU_USER;

    const formData = new FormData();
    formData.append("eventIds", "event-1");
    formData.set("confirmEmptyDeletion", "true");

    await createFromEvents(formData);

    expect(createAtomicUpdateFromEvents).toHaveBeenCalledWith({
      tenantId: AU_TENANT,
      userId: AU_USER,
      eventIds: ["event-1"],
      confirmEmptyDeletion: true,
    });
  });

  it("derives tenantId/userId from the session, ignoring any tenantId/userId fields present on formData", async () => {
    currentTenantId = AU_TENANT;
    currentUserId = AU_USER;

    const formData = new FormData();
    formData.append("eventIds", "event-1");
    // A malicious or stale client could stuff these in; the action must never
    // read them.
    formData.set("tenantId", "some-other-tenant");
    formData.set("userId", "some-other-user");

    await createFromEvents(formData);

    expect(createAtomicUpdateFromEvents).toHaveBeenCalledWith({
      tenantId: AU_TENANT,
      userId: AU_USER,
      eventIds: ["event-1"],
      confirmEmptyDeletion: false,
    });
  });

  it("returns {ok:false, reason} from the core without throwing, and still revalidates", async () => {
    currentTenantId = AU_TENANT;
    currentUserId = AU_USER;
    vi.mocked(createAtomicUpdateFromEvents).mockResolvedValueOnce({
      ok: false,
      reason: "One or more change events were not found.",
    });

    const formData = new FormData();
    formData.append("eventIds", "event-1");

    const result = await createFromEvents(formData);

    expect(result).toEqual({
      ok: false,
      reason: "One or more change events were not found.",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/atomic-updates");
  });

  it("returns a needsConfirmation result without throwing", async () => {
    currentTenantId = AU_TENANT;
    currentUserId = AU_USER;
    vi.mocked(createAtomicUpdateFromEvents).mockResolvedValueOnce({
      ok: false,
      reason: "needs_confirmation",
      needsConfirmation: true,
      emptiedAtomicUpdates: [{ id: "au-old", title: "Old one", inDraft: false }],
    });

    const formData = new FormData();
    formData.append("eventIds", "event-1");

    const result = await createFromEvents(formData);

    expect(result).toEqual({
      ok: false,
      reason: "needs_confirmation",
      needsConfirmation: true,
      emptiedAtomicUpdates: [{ id: "au-old", title: "Old one", inDraft: false }],
    });
  });
});

describe("addEventsToAtomicUpdate", () => {
  const EDIT_TENANT = "edit-evidence-session-tenant";
  const EDIT_USER = "edit-evidence-session-user";

  afterEach(() => {
    vi.mocked(addEventsToExistingAtomicUpdate).mockClear();
    vi.mocked(revalidatePath).mockClear();
    currentTenantId = "";
    currentUserId = null;
  });

  it("calls addEventsToExistingAtomicUpdate with the session's tenant/user and the given ids, then revalidates", async () => {
    currentTenantId = EDIT_TENANT;
    currentUserId = EDIT_USER;

    const result = await addEventsToAtomicUpdate("au-1", ["event-1", "event-2"]);

    expect(addEventsToExistingAtomicUpdate).toHaveBeenCalledWith({
      tenantId: EDIT_TENANT,
      userId: EDIT_USER,
      atomicUpdateId: "au-1",
      eventIds: ["event-1", "event-2"],
      confirmEmptyDeletion: undefined,
    });
    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/atomic-updates");
  });

  it("passes confirmEmptyDeletion through when the caller confirms an empty-source deletion", async () => {
    currentTenantId = EDIT_TENANT;
    currentUserId = EDIT_USER;

    await addEventsToAtomicUpdate("au-1", ["event-1"], true);

    expect(addEventsToExistingAtomicUpdate).toHaveBeenCalledWith({
      tenantId: EDIT_TENANT,
      userId: EDIT_USER,
      atomicUpdateId: "au-1",
      eventIds: ["event-1"],
      confirmEmptyDeletion: true,
    });
  });

  it("returns a needsConfirmation result from the core without throwing", async () => {
    currentTenantId = EDIT_TENANT;
    currentUserId = EDIT_USER;
    vi.mocked(addEventsToExistingAtomicUpdate).mockResolvedValueOnce({
      ok: false,
      reason: "needs_confirmation",
      needsConfirmation: true,
      emptiedAtomicUpdates: [{ id: "au-old", title: "Old one", inDraft: false }],
    });

    const result = await addEventsToAtomicUpdate("au-1", ["event-1"]);

    expect(result).toEqual({
      ok: false,
      reason: "needs_confirmation",
      needsConfirmation: true,
      emptiedAtomicUpdates: [{ id: "au-old", title: "Old one", inDraft: false }],
    });
    expect(revalidatePath).toHaveBeenCalledWith("/atomic-updates");
  });

  it("returns a rejection from the core (e.g. event in a released atomic update) without throwing", async () => {
    currentTenantId = EDIT_TENANT;
    currentUserId = EDIT_USER;
    vi.mocked(addEventsToExistingAtomicUpdate).mockResolvedValueOnce({
      ok: false,
      reason: "Cannot move an event out of the published atomic update \"Shipped\".",
    });

    const result = await addEventsToAtomicUpdate("au-1", ["event-1"]);

    expect(result).toEqual({
      ok: false,
      reason: "Cannot move an event out of the published atomic update \"Shipped\".",
    });
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
