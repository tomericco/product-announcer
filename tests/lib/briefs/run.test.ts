import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, companyProfiles, signals, briefs, briefSignals } from "../../../src/db/schema";
import { runIdeation, BRIEF_TTL_DAYS } from "../../../src/lib/briefs/run";

const TENANT = "Ideation Run Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  vi.restoreAllMocks();
});

async function seedTenant(topics: string[] = ["localization"]) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  await db.insert(companyProfiles).values({ tenantId: tenant.id, topics });
  return tenant;
}

async function seedSignal(tenantId: string, externalId: string, occurredAt = new Date()) {
  const [s] = await db
    .insert(signals)
    .values({
      tenantId,
      kind: "market_news",
      externalId,
      title: `Title ${externalId}`,
      excerpt: `Excerpt ${externalId}`,
      occurredAt,
      relevanceScore: 0.8,
    })
    .returning();
  return s;
}

const proposal = (evidence: string[]) => ({
  contentType: "blog_post" as const,
  title: "A brief",
  angle: "An angle",
  whyNow: "Because of something dated",
  audience: null,
  keyPoints: ["One.", "Two.", "Three."],
  targetLength: 800,
  suggestedChannel: "blog",
  evidenceSignalIds: evidence,
  score: 0.8,
  scoreRationale: "Strong",
});

describe("runIdeation", () => {
  it("writes a brief and its evidence join", async () => {
    const tenant = await seedTenant();
    const s = await seedSignal(tenant.id, "https://n.example.com/a");

    const result = await runIdeation(tenant.id, {
      database: db,
      ideateFn: vi.fn().mockResolvedValue({
        assessment: "Busy fortnight.",
        actions: [{ type: "propose", brief: proposal([s.id]) }],
      }),
    });

    expect(result).toMatchObject({ proposed: 1, extended: 0, assessment: "Busy fortnight." });

    const [brief] = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(brief.origin).toBe("agent");
    expect(brief.status).toBe("new");
    expect(brief.title).toBe("A brief");
    expect(brief.keyPoints).toHaveLength(3);

    const joins = await db.select().from(briefSignals).where(eq(briefSignals.briefId, brief.id));
    expect(joins).toHaveLength(1);
    expect(joins[0].signalId).toBe(s.id);
    // Null addedBy is what marks agent-attached evidence.
    expect(joins[0].addedBy).toBeNull();
  });

  it("sets an expiry so the inbox cannot accumulate debt", async () => {
    const tenant = await seedTenant();
    const s = await seedSignal(tenant.id, "https://n.example.com/a");
    const before = Date.now();

    await runIdeation(tenant.id, {
      database: db,
      ideateFn: vi.fn().mockResolvedValue({ assessment: "x", actions: [{ type: "propose", brief: proposal([s.id]) }] }),
    });

    const [brief] = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    const expectedMin = before + (BRIEF_TTL_DAYS - 1) * 24 * 60 * 60 * 1000;
    expect(brief.expiresAt.getTime()).toBeGreaterThan(expectedMin);
  });

  it("extends an open brief instead of writing a duplicate", async () => {
    const tenant = await seedTenant();
    const s1 = await seedSignal(tenant.id, "https://n.example.com/a");
    const s2 = await seedSignal(tenant.id, "https://n.example.com/b");

    const [existing] = await db
      .insert(briefs)
      .values({
        tenantId: tenant.id,
        origin: "agent",
        contentType: "blog_post",
        title: "Existing",
        angle: "A",
        whyNow: "W",
        suggestedChannel: "blog",
        keyPoints: ["One.", "Two.", "Three."],
        score: 0.5,
        lastEvidenceAt: new Date("2026-01-01T00:00:00Z"),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    await db.insert(briefSignals).values({ briefId: existing.id, signalId: s1.id });

    const result = await runIdeation(tenant.id, {
      database: db,
      ideateFn: vi.fn().mockResolvedValue({
        assessment: "x",
        actions: [{ type: "extend", briefId: existing.id, evidenceSignalIds: [s2.id] }],
      }),
    });

    expect(result).toMatchObject({ proposed: 0, extended: 1 });

    const all = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(all).toHaveLength(1);

    const joins = await db.select().from(briefSignals).where(eq(briefSignals.briefId, existing.id));
    expect(joins).toHaveLength(2);

    const [after] = all;
    // A brief that keeps gathering support must not age out.
    expect(after.lastEvidenceAt.getTime()).toBeGreaterThan(existing.lastEvidenceAt.getTime());
  });

  it("re-attaching the same signal to the same brief is idempotent", async () => {
    const tenant = await seedTenant();
    const s = await seedSignal(tenant.id, "https://n.example.com/a");
    const [existing] = await db
      .insert(briefs)
      .values({
        tenantId: tenant.id,
        origin: "agent",
        contentType: "blog_post",
        title: "Existing",
        angle: "A",
        whyNow: "W",
        suggestedChannel: "blog",
        keyPoints: ["One.", "Two.", "Three."],
        score: 0.5,
        lastEvidenceAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    await db.insert(briefSignals).values({ briefId: existing.id, signalId: s.id });

    await expect(
      runIdeation(tenant.id, {
        database: db,
        ideateFn: vi.fn().mockResolvedValue({
          assessment: "x",
          actions: [{ type: "extend", briefId: existing.id, evidenceSignalIds: [s.id] }],
        }),
      })
    ).resolves.toBeDefined();

    const joins = await db.select().from(briefSignals).where(eq(briefSignals.briefId, existing.id));
    expect(joins).toHaveLength(1);
  });

  it("offers only `new` briefs for extension, never accepted or dismissed ones", async () => {
    const tenant = await seedTenant();
    await seedSignal(tenant.id, "https://n.example.com/a");
    const base = {
      tenantId: tenant.id,
      origin: "agent" as const,
      contentType: "blog_post" as const,
      angle: "A",
      whyNow: "W",
      suggestedChannel: "blog",
      keyPoints: ["One.", "Two.", "Three."],
      score: 0.5,
      lastEvidenceAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    await db.insert(briefs).values({ ...base, title: "Still open", status: "new" });
    await db.insert(briefs).values({ ...base, title: "Already accepted", status: "accepted" });
    await db.insert(briefs).values({
      ...base,
      title: "Rejected once",
      status: "dismissed",
      dismissReason: "not_our_voice",
      dismissNote: "Too promotional",
    });

    const ideateFn = vi.fn().mockResolvedValue({ assessment: "x", actions: [] });
    await runIdeation(tenant.id, { database: db, ideateFn });

    const call = ideateFn.mock.calls[0][0];
    expect(call.openBriefs.map((b: { title: string }) => b.title)).toEqual(["Still open"]);
    // Accepted and dismissed briefs are context, not extension targets —
    // otherwise a dismissed brief comes straight back.
    expect(call.context.covered).toContain("Already accepted");
    expect(call.context.rejected.join(" ")).toContain("Too promotional");
  });

  it("writes nothing when ideation fails", async () => {
    const tenant = await seedTenant();
    await seedSignal(tenant.id, "https://n.example.com/a");

    const result = await runIdeation(tenant.id, {
      database: db,
      ideateFn: vi.fn().mockResolvedValue({ error: "Error: overloaded" }),
    });

    expect(result).toMatchObject({ proposed: 0, extended: 0, assessment: null });
    const all = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(all).toHaveLength(0);
  });

  it("passes only signals inside the ideation window", async () => {
    const tenant = await seedTenant();
    const fresh = await seedSignal(tenant.id, "https://n.example.com/fresh", new Date());
    await seedSignal(tenant.id, "https://n.example.com/old", new Date(Date.now() - 45 * 24 * 60 * 60 * 1000));

    const ideateFn = vi.fn().mockResolvedValue({ assessment: "x", actions: [] });
    await runIdeation(tenant.id, { database: db, ideateFn });

    const passed = ideateFn.mock.calls[0][0].signals as { id: string }[];
    expect(passed.map((s) => s.id)).toEqual([fresh.id]);
  });
});
