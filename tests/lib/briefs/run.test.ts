import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, companyProfiles, signals, briefs, briefSignals } from "../../../src/db/schema";
import { runIdeation, BRIEF_TTL_DAYS, MAX_IDEATION_SIGNALS } from "../../../src/lib/briefs/run";

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
    expect(after.lastEvidenceAt.getTime()).toBeGreaterThan(existing.lastEvidenceAt.getTime());
  });

  it("pushes an extended brief's expiry back, so support keeps it alive", async () => {
    const tenant = await seedTenant();
    const s = await seedSignal(tenant.id, "https://n.example.com/a");
    // A day from expiry: without the bump this brief is gone tomorrow, however
    // much evidence arrives today.
    const nearlyExpired = new Date(Date.now() + 86_400_000);
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
        expiresAt: nearlyExpired,
      })
      .returning();

    const before = Date.now();
    await runIdeation(tenant.id, {
      database: db,
      ideateFn: vi.fn().mockResolvedValue({
        assessment: "x",
        actions: [{ type: "extend", briefId: existing.id, evidenceSignalIds: [s.id] }],
      }),
    });

    const [after] = await db.select().from(briefs).where(eq(briefs.id, existing.id));
    expect(after.expiresAt.getTime()).toBeGreaterThan(nearlyExpired.getTime());
    // A full fresh TTL, not a nudge.
    expect(after.expiresAt.getTime()).toBeGreaterThan(before + (BRIEF_TTL_DAYS - 1) * 24 * 60 * 60 * 1000);
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
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runIdeation(tenant.id, {
      database: db,
      ideateFn: vi.fn().mockResolvedValue({ error: "Error: overloaded" }),
    });

    expect(result).toMatchObject({ proposed: 0, extended: 0, assessment: null });
    const all = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(all).toHaveLength(0);
  });

  it("logs a failed ideation, so it cannot pass for a quiet company", async () => {
    const tenant = await seedTenant();
    await seedSignal(tenant.id, "https://n.example.com/a");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runIdeation(tenant.id, {
      database: db,
      ideateFn: vi.fn().mockResolvedValue({ error: "Error: overloaded" }),
    });

    // An empty inbox is supposed to mean "nothing was worth saying". A broken
    // model call that logs nothing makes that promise unfalsifiable.
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[ideation]");
    expect(logged).toContain(tenant.id);
    expect(logged).toContain("overloaded");
  });

  it("caps how many signals reach the model", async () => {
    const tenant = await seedTenant();
    // One over the cap, each a minute older than the last so the ordering the
    // slice relies on is real rather than incidental.
    const total = MAX_IDEATION_SIGNALS + 1;
    const newest = Date.now();
    await db.insert(signals).values(
      Array.from({ length: total }, (_, i) => ({
        tenantId: tenant.id,
        kind: "market_news" as const,
        externalId: `https://n.example.com/${i}`,
        title: `Title https://n.example.com/${i}`,
        excerpt: null,
        occurredAt: new Date(newest - i * 60_000),
        relevanceScore: 0.8,
      }))
    );

    const ideateFn = vi.fn().mockResolvedValue({ assessment: "x", actions: [] });
    await runIdeation(tenant.id, { database: db, ideateFn });

    const passed = ideateFn.mock.calls[0][0].signals as { title: string }[];
    expect(passed).toHaveLength(MAX_IDEATION_SIGNALS);
    // The freshest survive the slice; the oldest is what gets dropped.
    expect(passed[0].title).toBe("Title https://n.example.com/0");
    expect(passed.map((s) => s.title)).not.toContain(`Title https://n.example.com/${total - 1}`);
  });

  it("does not hand the strategist a first-seen timestamp as a publication date", async () => {
    const tenant = await seedTenant();
    // How an undated article is stored: `runNewsSource` falls back to run time,
    // so `occurredAt` lands within the write round-trip of `createdAt`.
    await seedSignal(tenant.id, "https://n.example.com/undated");

    const ideateFn = vi.fn().mockResolvedValue({ assessment: "x", actions: [] });
    await runIdeation(tenant.id, { database: db, ideateFn });

    const passed = ideateFn.mock.calls[0][0].signals as { occurredAt: Date | null }[];
    expect(passed).toHaveLength(1);
    // `listSignals` orders desc(occurredAt), so these sort FIRST — the model
    // would see a two-year-old evergreen guide dated today, at the top of the
    // list, and could build a `whyNow` asserting recency that a human reads as
    // fact.
    expect(passed[0].occurredAt).toBeNull();
  });

  it("keeps a real publication date, and keeps a competitor signal's first-seen date", async () => {
    const tenant = await seedTenant();
    const published = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await seedSignal(tenant.id, "https://n.example.com/dated", published);
    // A competitor move also carries first-seen time — but there it is the
    // truth: diffing only observes forward changes, so a block that is new on
    // this run genuinely appeared since the last one. Blanking it would throw
    // away a real date.
    await db.insert(signals).values({
      tenantId: tenant.id,
      kind: "competitor_move",
      externalId: "https://rival.example.com/pricing#block",
      title: "Rival changed its pricing page",
      occurredAt: new Date(),
      relevanceScore: 0.8,
    });

    const ideateFn = vi.fn().mockResolvedValue({ assessment: "x", actions: [] });
    await runIdeation(tenant.id, { database: db, ideateFn });

    const passed = ideateFn.mock.calls[0][0].signals as { kind: string; occurredAt: Date | null }[];
    const news = passed.find((s) => s.kind === "market_news");
    const competitor = passed.find((s) => s.kind === "competitor_move");
    expect(news?.occurredAt?.toISOString()).toBe(published.toISOString());
    expect(competitor?.occurredAt).not.toBeNull();
  });

  it("puts expired briefs in the covered context, labelled as undecided", async () => {
    const tenant = await seedTenant();
    await seedSignal(tenant.id, "https://n.example.com/a");
    await db.insert(briefs).values({
      tenantId: tenant.id,
      origin: "agent",
      contentType: "blog_post",
      title: "Nobody decided on this",
      angle: "A",
      whyNow: "W",
      suggestedChannel: "blog",
      keyPoints: ["One.", "Two.", "Three."],
      score: 0.5,
      status: "expired",
      lastEvidenceAt: new Date(),
      expiresAt: new Date(Date.now() - 86_400_000),
    });

    const ideateFn = vi.fn().mockResolvedValue({ assessment: "x", actions: [] });
    await runIdeation(tenant.id, { database: db, ideateFn });

    const covered = ideateFn.mock.calls[0][0].context.covered as string[];
    // Expired briefs are in no other channel: their evidence stays in the
    // 30-day window for a fortnight after the 14-day TTL runs out, so without
    // this the inbox re-proposes them.
    const entry = covered.find((c) => c.startsWith("Nobody decided on this"));
    expect(entry).toBeDefined();
    // Labelled, so the model does not read an undecided brief as published work.
    expect(entry).toContain("expired without a decision");
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
