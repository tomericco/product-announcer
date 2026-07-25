import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, changeEvents } from "../../../src/db/schema";
import { ingestNotionTask } from "../../../src/lib/change-events/ingest-notion-task";

const TENANT = "Ingest Notion Task Test Tenant";

async function tenantId(): Promise<string> {
  const [t] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  return t.id;
}

function baseInput(tid: string, over: Partial<Parameters<typeof ingestNotionTask>[0]> = {}) {
  return {
    tenantId: tid,
    pageId: "page-1",
    title: "Add CSV export",
    description: "Export a report as CSV.",
    url: "https://notion.so/page-1",
    completedAt: new Date("2026-07-24T10:00:00Z"),
    ...over,
  };
}

describe("ingestNotionTask", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("drops a title-less task in tier 1 and never enriches or resolves", async () => {
    const tid = await tenantId();
    const enrich = vi.fn();
    const resolvePending = vi.fn();
    await ingestNotionTask(baseInput(tid, { title: "  " }), { enrich, resolvePending });

    expect(enrich).not.toHaveBeenCalled();
    expect(resolvePending).not.toHaveBeenCalled();
    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tid));
    expect(row.status).toBe("ignored");
    expect(row.filterReason).toBe("empty_task");
  });

  it("keeps a title-only task (empty description) and enriches it", async () => {
    const tid = await tenantId();
    const enrich = vi.fn(async () => ({
      userFacing: true,
      impactSummary: "s",
      suggestedCategory: "new" as const,
      confidence: 0.9,
    }));
    const resolvePending = vi.fn(async () => {});
    await ingestNotionTask(baseInput(tid, { description: null }), { enrich, resolvePending });

    expect(enrich).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tid));
    expect(row.status).not.toBe("ignored");
    expect(row.filterReason).toBeNull();
    expect(resolvePending).toHaveBeenCalledWith(tid, [row.id]);
  });

  it("enriches, stores a task event with null repoId, and resolves when user-facing", async () => {
    const tid = await tenantId();
    const enrich = vi.fn(async () => ({ userFacing: true, impactSummary: "Export to CSV.", suggestedCategory: "new" as const, confidence: 0.9 }));
    const resolvePending = vi.fn(async () => {});
    await ingestNotionTask(baseInput(tid), { enrich, resolvePending });

    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tid));
    expect(row.type).toBe("task");
    expect(row.provider).toBe("notion");
    expect(row.repoId).toBeNull();
    expect(row.externalId).toBe("page-1");
    expect(row.taskTitle).toBe("Add CSV export");
    expect(row.userFacing).toBe(true);
    expect(resolvePending).toHaveBeenCalledWith(tid, [row.id]);
  });

  it("is idempotent: a second delivery inserts no new row and does not re-resolve", async () => {
    const tid = await tenantId();
    const enrich = vi.fn(async () => ({ userFacing: true, impactSummary: "s", suggestedCategory: "new" as const, confidence: 0.9 }));
    const resolvePending = vi.fn(async () => {});
    await ingestNotionTask(baseInput(tid), { enrich, resolvePending });
    await ingestNotionTask(baseInput(tid), { enrich, resolvePending });

    const rows = await db
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.tenantId, tid), eq(changeEvents.externalId, "page-1")));
    expect(rows).toHaveLength(1);
    expect(resolvePending).toHaveBeenCalledTimes(1);
  });

  it("does not resolve when the enricher says not user-facing", async () => {
    const tid = await tenantId();
    const enrich = vi.fn(async () => ({ userFacing: false, impactSummary: null, suggestedCategory: null, confidence: 0.9 }));
    const resolvePending = vi.fn(async () => {});
    await ingestNotionTask(baseInput(tid), { enrich, resolvePending });
    expect(resolvePending).not.toHaveBeenCalled();
  });
});
