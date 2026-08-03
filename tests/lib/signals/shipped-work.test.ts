import { describe, it, expect, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, atomicUpdates, changeEvents, signals } from "../../../src/db/schema";
import { syncShippedWorkSignals } from "../../../src/lib/signals/shipped-work";
import { listSignals } from "../../../src/lib/signals/query";

const TENANT = "Shipped Work Signals Test Tenant";

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

async function shippedSignals(tenantId: string) {
  return db.select().from(signals).where(and(eq(signals.tenantId, tenantId), eq(signals.kind, "shipped_work")));
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

describe("syncShippedWorkSignals", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("projects an open atomic update into a signal", async () => {
    const tenant = await seedTenant();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "SAML SSO", summary: "Teams can log in with SAML." })
      .returning();

    await syncShippedWorkSignals();

    const rows = await shippedSignals(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe(atomic.id);
    expect(rows[0].atomicUpdateId).toBe(atomic.id);
    expect(rows[0].title).toBe("SAML SSO");
    expect(rows[0].excerpt).toBe("Teams can log in with SAML.");
    expect(rows[0].status).toBe("new");
    // No linked change events to date it, so occurredAt falls back to the
    // atomic update's own createdAt.
    expect(rows[0].occurredAt.getTime()).toBe(atomic.createdAt.getTime());
  });

  it("is idempotent across runs", async () => {
    const tenant = await seedTenant();
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S" });
    await syncShippedWorkSignals();
    const [first] = await shippedSignals(tenant.id);

    await syncShippedWorkSignals();

    const rows = await shippedSignals(tenant.id);
    expect(rows).toHaveLength(1);
    // Same row, not a delete-and-reinsert: a plain insert (rather than an
    // upsert) would violate the unique constraint on the second run, and if
    // that violation were swallowed the row count alone wouldn't catch it.
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].createdAt).toEqual(first.createdAt);
  });

  it("refreshes title and excerpt when the atomic update changes", async () => {
    const tenant = await seedTenant();
    const [atomic] = await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Old", summary: "Old summary" }).returning();
    await syncShippedWorkSignals();

    await db.update(atomicUpdates).set({ title: "New", summary: "New summary" }).where(eq(atomicUpdates.id, atomic.id));
    await syncShippedWorkSignals();

    const rows = await shippedSignals(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("New");
    expect(rows[0].excerpt).toBe("New summary");
  });

  it("marks the signal stale (not deleted) when the atomic update is hidden, and restores it to new when unhidden", async () => {
    const tenant = await seedTenant();
    const [atomic] = await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S" }).returning();
    await syncShippedWorkSignals();
    const [created] = await shippedSignals(tenant.id);
    expect(created.status).toBe("new");

    await db.update(atomicUpdates).set({ status: "hidden" }).where(eq(atomicUpdates.id, atomic.id));
    await syncShippedWorkSignals();

    const afterHide = await shippedSignals(tenant.id);
    // Still one row — the withdrawal marks stale, it does not delete. A
    // signal is durable evidence: spec 5's brief_signals will cascade on
    // signal delete, and this reconciler must never be the thing that erases
    // the evidence trail behind a hidden-then-unhidden atomic update.
    expect(afterHide).toHaveLength(1);
    expect(afterHide[0].id).toBe(created.id);
    expect(afterHide[0].status).toBe("stale");
    // `listSignals` excludes stale by default, so the browser behaves exactly
    // as if the signal were gone even though the row survives underneath.
    expect(await listSignals(tenant.id, {})).toHaveLength(0);

    await db.update(atomicUpdates).set({ status: "open" }).where(eq(atomicUpdates.id, atomic.id));
    await syncShippedWorkSignals();

    const afterUnhide = await shippedSignals(tenant.id);
    expect(afterUnhide).toHaveLength(1);
    expect(afterUnhide[0].id).toBe(created.id);
    expect(afterUnhide[0].status).toBe("new");
  });

  it("keeps relevanceScore, relevanceRationale and topics through a hide/unhide toggle", async () => {
    const tenant = await seedTenant();
    const [atomic] = await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S" }).returning();
    await syncShippedWorkSignals();
    const [created] = await shippedSignals(tenant.id);

    await db
      .update(signals)
      .set({ relevanceScore: 0.83, relevanceRationale: "Matches positioning on SSO.", topics: ["security"] })
      .where(eq(signals.id, created.id));

    await db.update(atomicUpdates).set({ status: "hidden" }).where(eq(atomicUpdates.id, atomic.id));
    await syncShippedWorkSignals();

    const [hidden] = await shippedSignals(tenant.id);
    expect(hidden.id).toBe(created.id);
    expect(hidden.relevanceScore).toBe(0.83);
    expect(hidden.relevanceRationale).toBe("Matches positioning on SSO.");
    expect(hidden.topics).toEqual(["security"]);

    await db.update(atomicUpdates).set({ status: "open" }).where(eq(atomicUpdates.id, atomic.id));
    await syncShippedWorkSignals();

    const [restored] = await shippedSignals(tenant.id);
    expect(restored.id).toBe(created.id);
    expect(restored.status).toBe("new");
    expect(restored.relevanceScore).toBe(0.83);
    expect(restored.relevanceRationale).toBe("Matches positioning on SSO.");
    expect(restored.topics).toEqual(["security"]);
  });

  it("does not clobber a `used` signal on a routine re-sync (the atomic update is still visible)", async () => {
    const tenant = await seedTenant();
    const [atomic] = await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S" }).returning();
    await syncShippedWorkSignals();
    const [created] = await shippedSignals(tenant.id);
    await db.update(signals).set({ status: "used" }).where(eq(signals.id, created.id));

    // A refresh with the atomic update still open/visible (e.g. title edited)
    // must not touch a non-stale status.
    await db.update(atomicUpdates).set({ title: "A (edited)" }).where(eq(atomicUpdates.id, atomic.id));
    await syncShippedWorkSignals();

    const [after] = await shippedSignals(tenant.id);
    expect(after.status).toBe("used");
    expect(after.title).toBe("A (edited)");
  });

  it("projects released atomic updates too — shipping is exactly what makes them signal", async () => {
    const tenant = await seedTenant();
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S", status: "released" });
    await syncShippedWorkSignals();
    expect(await shippedSignals(tenant.id)).toHaveLength(1);
  });

  it("does not project an atomic update created outside the 60-day signal window", async () => {
    const tenant = await seedTenant();
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Old", summary: "S", createdAt: daysAgo(70) });

    await syncShippedWorkSignals();

    expect(await shippedSignals(tenant.id)).toHaveLength(0);
  });

  it("leaves a shipped_work signal outside the window untouched instead of stale-marking it", async () => {
    const tenant = await seedTenant();
    // Simulates a signal from a prior run whose atomic update is now gone or
    // hidden, and which has aged out of the window. It must not be touched:
    // it's already invisible to every reader, and churning it every run buys
    // nothing while working against the eventual purge job.
    const old = daysAgo(90);
    await db.insert(signals).values({
      tenantId: tenant.id,
      kind: "shipped_work",
      externalId: "orphaned-outside-window",
      title: "Orphaned old signal",
      occurredAt: old,
      createdAt: old,
    });

    await syncShippedWorkSignals();

    const [orphan] = await db
      .select()
      .from(signals)
      .where(eq(signals.externalId, "orphaned-outside-window"));
    expect(orphan.status).toBe("new");
  });

  it("derives occurredAt from the linked change event's real date, not from when the atomic update was created", async () => {
    const tenant = await seedTenant();
    const [atomic] = await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S" }).returning();
    const mergedAt = new Date();
    mergedAt.setFullYear(mergedAt.getFullYear() - 1);
    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      type: "pull_request",
      provider: "github",
      externalId: "gh-merged-1",
      atomicUpdateId: atomic.id,
      mergedAt,
    });

    await syncShippedWorkSignals();

    const [row] = await shippedSignals(tenant.id);
    expect(row.occurredAt.toISOString()).toBe(mergedAt.toISOString());
    // The point of the fix: a year-old merge must not read as fresh just
    // because the atomic update wrapping it was created today.
    expect(row.occurredAt.getFullYear()).toBe(new Date().getFullYear() - 1);
  });

  it("takes the most recent date across multiple linked change events", async () => {
    const tenant = await seedTenant();
    const [atomic] = await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S" }).returning();
    const earlier = new Date("2025-01-01T00:00:00.000Z");
    const later = new Date("2025-06-01T00:00:00.000Z");
    await db.insert(changeEvents).values([
      {
        tenantId: tenant.id,
        type: "commit",
        provider: "github",
        externalId: "sha-earlier",
        atomicUpdateId: atomic.id,
        committedAt: earlier,
        releasedAt: earlier,
      },
      {
        tenantId: tenant.id,
        type: "commit",
        provider: "github",
        externalId: "sha-later",
        atomicUpdateId: atomic.id,
        committedAt: later,
        releasedAt: later,
      },
    ]);

    await syncShippedWorkSignals();

    const [row] = await shippedSignals(tenant.id);
    expect(row.occurredAt.toISOString()).toBe(later.toISOString());
  });
});
