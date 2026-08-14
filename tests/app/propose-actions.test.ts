import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, briefs, briefSignals, signals } from "../../src/db/schema";

const TENANT = "Propose Actions Test Tenant";
let currentTenantId = "";
let currentUserId: string | null = null;

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// This wrapper is deliberately thin — the tenant-scoped resolution and the
// model call live in `proposeBriefForSelection` (`src/lib/briefs/propose-selection.ts`,
// tested directly in `tests/lib/briefs/propose-selection.test.ts`, including
// the tenant-by-id refusal). Mocking that seam here means these tests never
// touch the model at all, and stay focused on what this file actually does:
// resolve the session's tenant, and glue the proposal to `createManualBrief`.
vi.mock("../../src/lib/briefs/propose-selection", () => ({
  proposeBriefForSelection: vi.fn(),
}));

import { proposeAndCreateBrief } from "../../src/app/(dashboard)/signals/propose-actions";
import { proposeBriefForSelection } from "../../src/lib/briefs/propose-selection";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  vi.clearAllMocks();
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  currentTenantId = tenant.id;
  return tenant;
}

async function seedSignal(tenantId: string, title = "Evidence") {
  const [row] = await db
    .insert(signals)
    .values({ tenantId, kind: "manual", externalId: crypto.randomUUID(), title, occurredAt: new Date() })
    .returning();
  return row;
}

const GOOD_INPUT = {
  contentType: "blog_post" as const,
  title: "A proposed title",
  angle: "A sharp angle",
  whyNow: "Because of the signal",
  keyPoints: ["One.", "Two.", "Three."],
  suggestedChannel: "blog",
  targetLength: 700,
  audience: null,
  score: 0.7,
  scoreRationale: "Strong evidence, clear angle.",
};

describe("proposeAndCreateBrief", () => {
  it("creates exactly one brief, linked to the resolved signals, with a non-blank body", async () => {
    const tenant = await seedTenant();
    currentUserId = null;
    const signal = await seedSignal(tenant.id);

    vi.mocked(proposeBriefForSelection).mockResolvedValue({
      ok: true,
      input: { ...GOOD_INPUT, signalIds: [signal.id] },
    });

    const result = await proposeAndCreateBrief([signal.id]);

    expect(proposeBriefForSelection).toHaveBeenCalledWith(tenant.id, [signal.id]);
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

  it("returns a reason and creates no brief when the proposal fails, without calling createManualBrief", async () => {
    const tenant = await seedTenant();
    currentUserId = null;

    const before = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(before).toHaveLength(0);

    vi.mocked(proposeBriefForSelection).mockResolvedValue({ ok: false, error: "model timeout" });

    const result = await proposeAndCreateBrief(["whatever-id"]);

    expect(result).toEqual({ ok: false, error: "model timeout" });

    const after = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(after).toHaveLength(0);
  });
});
