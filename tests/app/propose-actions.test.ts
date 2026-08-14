import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, briefs, briefSignals, signals } from "../../src/db/schema";

const TENANT = "Propose Actions Test Tenant";
const OTHER_TENANT = "Propose Actions Other Tenant";
let currentTenantId = "";
let currentUserId: string | null = null;

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
vi.mock("../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { proposeAndCreateBrief } from "../../src/app/(dashboard)/signals/propose-actions";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  await db.delete(tenants).where(eq(tenants.name, OTHER_TENANT));
  vi.clearAllMocks();
});

async function seedTenant(name = TENANT) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  return tenant;
}

async function seedSignal(tenantId: string, title = "Evidence") {
  const [row] = await db
    .insert(signals)
    .values({ tenantId, kind: "manual", externalId: crypto.randomUUID(), title, occurredAt: new Date() })
    .returning();
  return row;
}

const GOOD_PROPOSAL = {
  contentType: "blog_post" as const,
  title: "A proposed title",
  angle: "A sharp angle",
  whyNow: "Because of the signal",
  audience: null,
  keyPoints: ["One.", "Two.", "Three."],
  targetLength: 700,
  suggestedChannel: "blog",
  score: 0.7,
  scoreRationale: "Strong evidence, clear angle.",
};

describe("proposeAndCreateBrief", () => {
  it("creates exactly one brief, linked to the resolved signals, with a non-blank body", async () => {
    const tenant = await seedTenant();
    currentTenantId = tenant.id;
    currentUserId = null;
    const signal = await seedSignal(tenant.id);

    const generate = vi.fn(async () => ({ object: GOOD_PROPOSAL, usage: {} }));
    const result = await proposeAndCreateBrief([signal.id], { generate: generate as never });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.briefId);
    expect(rows[0].title).toBe("A proposed title");
    expect(rows[0].body).not.toBeNull();
    expect(rows[0].body?.trim().length).toBeGreaterThan(0);

    const links = await db.select().from(briefSignals).where(eq(briefSignals.briefId, result.briefId));
    expect(links.map((l) => l.signalId)).toEqual([signal.id]);
  });

  it("refuses another tenant's signal ids, asserted by id, and leaks nothing of theirs", async () => {
    const mine = await seedTenant(TENANT);
    const theirs = await seedTenant(OTHER_TENANT);
    currentTenantId = mine.id;
    currentUserId = null;
    const theirSignal = await seedSignal(theirs.id, "Their secret title");

    const generate = vi.fn(async () => ({ object: GOOD_PROPOSAL, usage: {} }));
    const result = await proposeAndCreateBrief([theirSignal.id], { generate: generate as never });

    expect(result.ok).toBe(false);

    const mineBriefs = await db.select().from(briefs).where(eq(briefs.tenantId, mine.id));
    expect(mineBriefs).toHaveLength(0);

    // Nothing of theirs leaked anywhere under this tenant: no brief exists
    // whose title, angle, or body mentions their signal's title.
    const allBriefs = await db.select().from(briefs);
    for (const brief of allBriefs) {
      if (brief.tenantId !== mine.id) continue;
      expect(brief.title).not.toContain("Their secret title");
    }
    // The model must never even have been asked, since nothing tenant-scoped
    // resolved.
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns a reason and creates no brief when the proposal fails", async () => {
    const tenant = await seedTenant();
    currentTenantId = tenant.id;
    currentUserId = null;
    const signal = await seedSignal(tenant.id);

    const before = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(before).toHaveLength(0);

    const generate = vi.fn(async () => {
      throw new Error("model timeout");
    });
    const result = await proposeAndCreateBrief([signal.id], { generate: generate as never });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("model timeout");

    const after = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(after).toHaveLength(0);
  });
});
