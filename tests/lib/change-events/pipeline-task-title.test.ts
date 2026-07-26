import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, changeEvents } from "../../../src/db/schema";
import { resolvePendingEvents } from "../../../src/lib/change-events/pipeline";

const TENANT = "Pipeline Task Title Test Tenant";

describe("resolvePendingEvents (task title)", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("passes a task's taskTitle to the resolver as the event title", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
    const [event] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: null,
        type: "task",
        provider: "notion",
        externalId: "page-abc",
        taskTitle: "Add CSV export",
        taskDescription: "Export a report as CSV.",
        impactSummary: "Users can export reports to CSV.",
        userFacing: true,
      })
      .returning({ id: changeEvents.id });

    const resolve = vi.fn().mockResolvedValue([]); // no actions -> nothing applied
    const refresh = vi.fn();

    await resolvePendingEvents(tenant.id, [event.id], { resolve, refresh });

    expect(resolve).toHaveBeenCalledTimes(1);
    const passed = resolve.mock.calls[0][0].events;
    expect(passed).toHaveLength(1);
    expect(passed[0].title).toBe("Add CSV export");
    expect(passed[0].type).toBe("task");
    expect(passed[0].summary).toBe("Users can export reports to CSV.");
  });
});
