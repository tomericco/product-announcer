import { describe, it, expect, afterEach, vi } from "vitest";

// Structural backstop: resolvePendingEvents makes real Sonnet/Haiku calls to
// Anthropic. Any test in this file that omits the `resolvePending` dep must
// never fall through to the live implementation, so the module is mocked
// here regardless of what individual tests pass.
vi.mock("../../../src/lib/change-events/pipeline", () => ({ resolvePendingEvents: vi.fn() }));

import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, changeEvents } from "../../../src/db/schema";
import { importSelectedTasks } from "../../../src/lib/change-events/import-notion-tasks";

const NAME = "Import Tasks Test Tenant";

describe("importSelectedTasks", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  async function seed() {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    return { tenant };
  }

  it("imports a new task as a pending task change event, counted and resolved", async () => {
    const { tenant } = await seed();
    const enrich = vi
      .fn()
      .mockResolvedValue({ userFacing: true, impactSummary: "Fixes X", suggestedCategory: "fix", confidence: 0.9 });
    const resolvePending = vi.fn();
    const getBody = vi.fn().mockResolvedValue("Body detail.");

    const result = await importSelectedTasks(
      {
        tenantId: tenant.id,
        selections: [
          { pageId: "page-1", title: "Fix SSO 502", url: "https://notion.so/page-1", completedAt: "2026-07-01T00:00:00Z" },
        ],
      },
      getBody,
      { enrich, resolvePending }
    );

    expect(result.importedCount).toBe(1);
    const [row] = await db
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.tenantId, tenant.id), eq(changeEvents.externalId, "page-1")));
    expect(row.type).toBe("task");
    expect(row.provider).toBe("notion");
    expect(row.status).toBe("pending");
    expect(row.repoId).toBeNull();
    expect(row.taskTitle).toBe("Fix SSO 502");
    expect(row.taskDescription).toBe("Body detail.");
    expect(row.externalUrl).toBe("https://notion.so/page-1");
    expect(row.completedAt).not.toBeNull();
    expect(enrich).toHaveBeenCalledWith(
      expect.objectContaining({ type: "task", taskTitle: "Fix SSO 502", taskDescription: "Body detail." })
    );
    expect(resolvePending).toHaveBeenCalledTimes(1);
    expect(resolvePending).toHaveBeenCalledWith(tenant.id, [row.id]);
  });

  it("resurrects an excluded task back to pending on re-import", async () => {
    const { tenant } = await seed();
    const [existing] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: null,
        type: "task",
        provider: "notion",
        externalId: "page-2",
        taskTitle: "Old title",
        status: "excluded",
        excludedAt: new Date(),
      })
      .returning();
    expect(existing.status).toBe("excluded");

    const enrich = vi
      .fn()
      .mockResolvedValue({ userFacing: true, impactSummary: "Adds Y", suggestedCategory: "new", confidence: 0.8 });
    const resolvePending = vi.fn();
    const getBody = vi.fn().mockResolvedValue("Fresh body.");

    const result = await importSelectedTasks(
      {
        tenantId: tenant.id,
        selections: [
          { pageId: "page-2", title: "New title", url: "https://notion.so/page-2", completedAt: "2026-07-02T00:00:00Z" },
        ],
      },
      getBody,
      { enrich, resolvePending }
    );

    expect(result.importedCount).toBe(1);
    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.id, existing.id));
    expect(row.status).toBe("pending");
    expect(row.excludedAt).toBeNull();
    expect(row.taskTitle).toBe("New title");
    expect(resolvePending).toHaveBeenCalledTimes(1);
    expect(resolvePending).toHaveBeenCalledWith(tenant.id, [existing.id]);
  });

  it("leaves an already-active task untouched (no-op, not counted, not resolved)", async () => {
    const { tenant } = await seed();
    const [existing] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: null,
        type: "task",
        provider: "notion",
        externalId: "page-3",
        taskTitle: "Already active",
        status: "pending",
      })
      .returning();

    const enrich = vi
      .fn()
      .mockResolvedValue({ userFacing: true, impactSummary: "Adds Z", suggestedCategory: "new", confidence: 0.8 });
    const resolvePending = vi.fn();
    const getBody = vi.fn().mockResolvedValue("Body.");

    const result = await importSelectedTasks(
      {
        tenantId: tenant.id,
        selections: [
          { pageId: "page-3", title: "Attempted overwrite", url: "https://notion.so/page-3", completedAt: null },
        ],
      },
      getBody,
      { enrich, resolvePending }
    );

    expect(result.importedCount).toBe(0);
    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.id, existing.id));
    expect(row.status).toBe("pending");
    expect(row.taskTitle).toBe("Already active"); // untouched, not overwritten
    expect(resolvePending).not.toHaveBeenCalled();
  });

  it("skips a selection whose getBody throws, but still imports the rest", async () => {
    const { tenant } = await seed();
    const enrich = vi
      .fn()
      .mockResolvedValue({ userFacing: true, impactSummary: "Adds W", suggestedCategory: "new", confidence: 0.8 });
    const resolvePending = vi.fn();
    const getBody = vi.fn().mockImplementation(async (pageId: string) => {
      if (pageId === "page-fail") throw new Error("Notion API error");
      return "OK body";
    });

    const result = await importSelectedTasks(
      {
        tenantId: tenant.id,
        selections: [
          { pageId: "page-fail", title: "Fails", url: "https://notion.so/page-fail", completedAt: null },
          { pageId: "page-ok", title: "OK", url: "https://notion.so/page-ok", completedAt: null },
        ],
      },
      getBody,
      { enrich, resolvePending }
    );

    expect(result.importedCount).toBe(1);
    const rows = await db
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.tenantId, tenant.id), eq(changeEvents.externalId, "page-ok")));
    expect(rows).toHaveLength(1);
    const failedRows = await db
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.tenantId, tenant.id), eq(changeEvents.externalId, "page-fail")));
    expect(failedRows).toHaveLength(0);
  });

  it("counts a not-userFacing task but does not resolve it", async () => {
    const { tenant } = await seed();
    const enrich = vi
      .fn()
      .mockResolvedValue({ userFacing: false, impactSummary: null, suggestedCategory: null, confidence: 0.1 });
    const resolvePending = vi.fn();
    const getBody = vi.fn().mockResolvedValue("Internal chore.");

    const result = await importSelectedTasks(
      {
        tenantId: tenant.id,
        selections: [
          { pageId: "page-4", title: "Internal chore", url: "https://notion.so/page-4", completedAt: null },
        ],
      },
      getBody,
      { enrich, resolvePending }
    );

    expect(result.importedCount).toBe(1);
    expect(resolvePending).not.toHaveBeenCalled();
  });
});
