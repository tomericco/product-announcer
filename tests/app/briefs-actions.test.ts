import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, briefs, contentPieces } from "../../src/db/schema";

const TENANT = "Briefs Actions Test Tenant";
let currentTenantId = "";
let currentUserId: string | null = null;

// requireSession() returns a NextAuth Session — tenantId lives under `user`,
// per src/types/next-auth.d.ts. Mirror that shape, not a flat one.
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { acceptBrief, dismissBrief, scaffoldBody } from "../../src/app/(dashboard)/briefs/actions";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  vi.clearAllMocks();
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  currentTenantId = tenant.id;
  return tenant;
}

async function seedBrief(tenantId: string, overrides: Partial<typeof briefs.$inferInsert> = {}) {
  const [brief] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin: "agent",
      contentType: "blog_post",
      title: "How localization breaks design systems",
      angle: "Most teams discover it too late",
      whyNow: "Two competitors shipped multilingual tooling this month",
      suggestedChannel: "blog",
      keyPoints: ["Point one", "Point two"],
      score: 0.8,
      lastEvidenceAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      ...overrides,
    })
    .returning();
  return brief;
}

describe("scaffoldBody", () => {
  it("includes the angle, the why-now and every key point", () => {
    const body = scaffoldBody({ angle: "A", whyNow: "W", keyPoints: ["One", "Two"] });
    expect(body).toContain("A");
    expect(body).toContain("W");
    expect(body).toContain("## One");
    expect(body).toContain("## Two");
  });

  it("produces a non-empty body when there are no key points", () => {
    // contentPieces.body is NOT NULL — an empty scaffold would fail the insert.
    expect(scaffoldBody({ angle: "A", whyNow: "W", keyPoints: [] }).trim().length).toBeGreaterThan(0);
  });
});

describe("acceptBrief", () => {
  it("creates one content piece and links it both ways", async () => {
    const tenant = await seedTenant();
    currentUserId = null;
    const brief = await seedBrief(tenant.id);

    const result = await acceptBrief(brief.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pieces = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
    expect(pieces).toHaveLength(1);
    expect(pieces[0].id).toBe(result.contentPieceId);
    expect(pieces[0].type).toBe("blog_post");
    expect(pieces[0].status).toBe("draft");
    expect(pieces[0].body).toContain("## Point one");

    const [after] = await db.select().from(briefs).where(eq(briefs.id, brief.id));
    expect(after.status).toBe("accepted");
    expect(after.contentPieceId).toBe(result.contentPieceId);
    expect(after.acceptedAt).toBeInstanceOf(Date);
  });

  it("refuses a brief belonging to another tenant and creates nothing", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedBrief(other.id);

    // currentTenantId is `mine`. The id came from a URL and is user-supplied;
    // briefs carry the company's unpublished content strategy.
    const result = await acceptBrief(theirs.id);
    expect(result.ok).toBe(false);

    const pieces = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, mine.id));
    expect(pieces).toHaveLength(0);
    const [untouched] = await db.select().from(briefs).where(eq(briefs.id, theirs.id));
    expect(untouched.status).toBe("new");
  });

  it("is a no-op on an already-accepted brief, not a second content piece", async () => {
    const tenant = await seedTenant();
    const brief = await seedBrief(tenant.id);

    await acceptBrief(brief.id);
    const second = await acceptBrief(brief.id);

    expect(second.ok).toBe(false);
    const pieces = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
    expect(pieces).toHaveLength(1);
  });

  it("leaves no orphan content piece when the brief cannot be transitioned", async () => {
    const tenant = await seedTenant();
    const brief = await seedBrief(tenant.id, { status: "dismissed" });

    const result = await acceptBrief(brief.id);
    expect(result.ok).toBe(false);
    const pieces = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
    expect(pieces).toHaveLength(0);
  });
});

describe("dismissBrief", () => {
  it("writes every dismissal column", async () => {
    const tenant = await seedTenant();
    currentUserId = null;
    const brief = await seedBrief(tenant.id);

    const result = await dismissBrief(brief.id, "already_covered", "We shipped this last week.");
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(briefs).where(eq(briefs.id, brief.id));
    expect(after.status).toBe("dismissed");
    expect(after.dismissReason).toBe("already_covered");
    expect(after.dismissNote).toBe("We shipped this last week.");
    expect(after.dismissedAt).toBeInstanceOf(Date);
  });

  it("refuses a brief belonging to another tenant", async () => {
    await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedBrief(other.id);

    const result = await dismissBrief(theirs.id, "off_topic");
    expect(result.ok).toBe(false);
    const [untouched] = await db.select().from(briefs).where(eq(briefs.id, theirs.id));
    expect(untouched.status).toBe("new");
  });

  it("is a no-op on a brief that was already decided", async () => {
    const tenant = await seedTenant();
    const brief = await seedBrief(tenant.id, { status: "accepted" });

    const result = await dismissBrief(brief.id, "off_topic");
    expect(result.ok).toBe(false);
    const [after] = await db.select().from(briefs).where(eq(briefs.id, brief.id));
    expect(after.status).toBe("accepted");
  });
});
