import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, briefs, briefSignals, signals } from "../../src/db/schema";
import { renderBriefBody } from "../../src/lib/briefs/body";

const TENANT = "New Brief Actions Test Tenant";
let currentTenantId = "";
let currentUserId: string | null = null;

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createManualBrief } from "../../src/app/(dashboard)/briefs/new/actions";

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

const FORM = {
  contentType: "blog_post" as const,
  title: "A title",
  angle: "An angle",
  whyNow: "Because",
  keyPoints: ["One.", "Two.", "Three."],
  suggestedChannel: "blog",
  targetLength: 700,
  audience: null,
  score: 0.7,
  scoreRationale: "Strong evidence, clear angle.",
};

describe("createManualBrief", () => {
  it("saves a manual brief that never expires, with its evidence attached", async () => {
    const tenant = await seedTenant();
    currentUserId = null;
    const signal = await seedSignal(tenant.id);

    const result = await createManualBrief({ ...FORM, signalIds: [signal.id] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [brief] = await db.select().from(briefs).where(eq(briefs.id, result.briefId));
    expect(brief.origin).toBe("manual");
    expect(brief.status).toBe("new");
    // A hand-written brief is a decision, not a proposal awaiting one.
    expect(brief.expiresAt).toBeNull();
    expect(brief.lastEvidenceAt).toBeInstanceOf(Date);
    // The proposal produces a rationale for its score; dropping it on save
    // would silently discard something the model wrote.
    expect(brief.scoreRationale).toBe("Strong evidence, clear angle.");

    const links = await db.select().from(briefSignals).where(eq(briefSignals.briefId, brief.id));
    expect(links.map((l) => l.signalId)).toEqual([signal.id]);
  });

  it("stores a rendered body equal to renderBriefBody of its own fields", async () => {
    await seedTenant();
    currentUserId = null;

    const result = await createManualBrief({ ...FORM, signalIds: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [brief] = await db.select().from(briefs).where(eq(briefs.id, result.briefId));
    expect(brief.body).not.toBeNull();
    expect(brief.body).toBe(
      renderBriefBody({
        angle: brief.angle,
        whyNow: brief.whyNow,
        keyPoints: brief.keyPoints,
        audience: brief.audience,
      })
    );
  });

  it("refuses a signal belonging to another tenant and writes nothing", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedSignal(other.id, "Theirs");

    // The ids come from a form field and are user-supplied. Attaching another
    // tenant's signal would leak its title into this tenant's brief and into
    // every draft generated from it.
    const result = await createManualBrief({ ...FORM, signalIds: [theirs.id] });
    expect(result.ok).toBe(false);
    expect(await db.select().from(briefs).where(eq(briefs.tenantId, mine.id))).toHaveLength(0);
  });

  it("refuses a blank title", async () => {
    const tenant = await seedTenant();
    const signal = await seedSignal(tenant.id);
    const result = await createManualBrief({ ...FORM, title: "  ", signalIds: [signal.id] });
    expect(result.ok).toBe(false);
    expect(await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id))).toHaveLength(0);
  });

  it("saves a brief with no signals at all", async () => {
    await seedTenant();
    // The degradation path: the proposal failed, the human wrote it themselves,
    // and they may not have selected anything. That must still save.
    const result = await createManualBrief({ ...FORM, signalIds: [] });
    expect(result.ok).toBe(true);
  });
});
