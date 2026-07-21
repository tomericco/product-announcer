import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn() }));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, atomicUpdates } from "../../../src/db/schema";
import {
  regenerateAtomicSummary,
  refreshAtomicUpdates,
} from "../../../src/lib/ai/regenerate-atomic-summary";

const TENANT = "Regenerate Summary Test Tenant";

describe("regenerateAtomicSummary", () => {
  afterEach(() => vi.mocked(generateObject).mockReset());

  it("returns the regenerated title and summary", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "CSV export", summary: "Export reports as CSV, now with headers." },
      usage: {},
    } as never);

    const result = await regenerateAtomicSummary({
      tenantId: "t1",
      current: { title: "CSV export", summary: "Export reports as CSV." },
      evidence: [{ type: "commit", title: "add headers to csv", summary: "Adds a header row." }],
    });

    expect(result).toEqual({ title: "CSV export", summary: "Export reports as CSV, now with headers." });
  });

  it("returns null on model error", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("boom"));

    const result = await regenerateAtomicSummary({
      tenantId: "t1",
      current: { title: "T", summary: "S" },
      evidence: [{ type: "commit", title: "x", summary: null }],
    });

    expect(result).toBeNull();
  });
});

describe("refreshAtomicUpdates", () => {
  afterEach(async () => {
    vi.mocked(generateObject).mockReset();
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("rewrites an unedited summary", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Old", summary: "Old summary." })
      .returning();

    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "New", summary: "New summary." },
      usage: {},
    } as never);

    await refreshAtomicUpdates(db, tenant.id, [atomic.id]);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.title).toBe("New");
    expect(after.summary).toBe("New summary.");
  });

  it("leaves a manually edited summary untouched and does not call the model", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({
        tenantId: tenant.id,
        title: "Hand written",
        summary: "Hand written summary.",
        summaryEditedAt: new Date(),
      })
      .returning();

    await refreshAtomicUpdates(db, tenant.id, [atomic.id]);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.summary).toBe("Hand written summary.");
    expect(generateObject).not.toHaveBeenCalled();
  });
});
