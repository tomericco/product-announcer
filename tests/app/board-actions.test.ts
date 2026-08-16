import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, contentPieces, briefs } from "../../src/db/schema";

const TENANT_NAME = "Board Actions Test Tenant";
let currentTenantId = "";

// requireSession() returns a NextAuth Session (tenantId lives under `user`) —
// mirror that shape, per the existing actions-test mocking style (see
// tests/app/drafts/reject-delete-actions.test.ts).
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// acceptBriefCard delegates to acceptBrief, whose `after()` callback runs
// generateDraftForPiece — which, unmocked, falls through to the real
// generateBriefDraft/generateReleaseDraft/reviewAndReconcile and reaches the
// real Anthropic API. This block mirrors tests/app/briefs-actions.test.ts's
// mocking exactly, for the same reason: no test in this suite may reach a
// real model. Stores the `after()` callback instead of invoking it inline —
// the real `after` defers until the response is finished, which never
// happens in a test — and `afterEach` below drains it AFTER each test's own
// assertions have run, so a test body genuinely sees the pre-generation
// state.
const pendingAfterCallbacks = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    pendingAfterCallbacks.push(fn);
  },
}));

const generateBriefDraft = vi.fn(async (..._args: unknown[]) => ({
  title: "Mock generated title",
  body: "Mock generated body.",
}));
const generateReleaseDraft = vi.fn(async () => ({
  title: "Mock release title",
  body: "Mock release body.",
}));
vi.mock("../../src/lib/ai/generation", () => ({
  generateBriefDraft: (...args: unknown[]) => generateBriefDraft(...args),
  generateReleaseDraft: () => generateReleaseDraft(),
}));

vi.mock("../../src/lib/ai/review-draft", () => ({
  reviewAndReconcile: vi.fn(async (draft: { title: string; body: string }) => ({
    finalDraft: draft,
    status: "passed" as const,
    issues: [] as string[],
  })),
}));

import { revalidatePath } from "next/cache";
import { moveCard, acceptBriefCard } from "../../src/app/(dashboard)/board/actions";

async function seed(status: "draft" | "review" = "draft") {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  currentTenantId = tenant.id;
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, title: "T", body: "B", status })
    .returning();
  return { tenant, piece };
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

afterEach(async () => {
  // Drain and await every `after()` callback scheduled by this test BEFORE
  // tearing down its tenant — otherwise the background generateDraftForPiece
  // write can land after the tenant row (and its FK targets) are gone.
  await Promise.all(pendingAfterCallbacks.splice(0).map((fn) => fn()));
  await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
  vi.clearAllMocks();
});

describe("moveCard", () => {
  // `new Date("garbage")` is an Invalid Date, not a thrown error — it is
  // still truthy, so without this check it would sail past
  // moveContentPiece's own "scheduledFor is required" guard and only fail
  // later, inside the write, as an uncaught RangeError from
  // `.toISOString()`. This pins the guard added to moveCard itself.
  it("refuses a move into scheduled carrying an invalid scheduledForIso, and leaves the piece untouched", async () => {
    const { piece } = await seed("review");

    const result = await moveCard(piece.id, "scheduled", "not-a-real-date");

    expect(result.ok).toBe(false);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("review");
    expect(after.scheduledFor).toBeNull();
  });

  it("accepts a move into scheduled carrying a valid ISO date", async () => {
    const { piece } = await seed("review");
    const when = new Date("2026-09-01T09:00:00Z");

    const result = await moveCard(piece.id, "scheduled", when.toISOString());

    expect(result).toEqual({ ok: true });
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("scheduled");
    expect(after.scheduledFor?.toISOString()).toBe(when.toISOString());
  });
});

/**
 * `acceptBriefCard` is the action behind dragging a brief card onto Draft
 * and confirming the drop. It is a thin wrapper around `acceptBrief`
 * (src/app/(dashboard)/briefs/actions.ts), which is already the authority on
 * accepting a brief — these tests assert the actual outcomes of acceptance
 * (a content piece exists, the brief flipped to `accepted`), not that
 * `acceptBrief` was called. Mocking `acceptBrief` away would only prove this
 * wrapper calls a function, not that accepting from the board does what it
 * claims to.
 */
describe("acceptBriefCard", () => {
  it("creates a content piece and flips the brief to accepted", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    currentTenantId = tenant.id;
    const brief = await seedBrief(tenant.id);

    const result = await acceptBriefCard(brief.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [piece] = await db
      .select()
      .from(contentPieces)
      .where(eq(contentPieces.id, result.contentPieceId));
    expect(piece).toBeDefined();
    expect(piece.tenantId).toBe(tenant.id);
    expect(piece.status).toBe("brief");

    const [after] = await db.select().from(briefs).where(eq(briefs.id, brief.id));
    expect(after.status).toBe("accepted");
    expect(after.contentPieceId).toBe(result.contentPieceId);

    // acceptBrief revalidates /board and /drafts itself; the board wrapper
    // is redundant with that /board call, kept anyway since acceptBrief has
    // no reason to know the board exists and shouldn't be trusted to keep
    // revalidating it.
    expect(revalidatePath).toHaveBeenCalledWith("/board");
  });

  it("is tenant-scoped: another tenant's brief id creates nothing", async () => {
    const [mine] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    currentTenantId = mine.id;
    const [theirTenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    const theirs = await seedBrief(theirTenant.id);

    const result = await acceptBriefCard(theirs.id);

    expect(result.ok).toBe(false);

    // Asserted by id, not by an empty result for "my" tenant — an empty
    // result there would pass even if the wrapper created a piece under the
    // OTHER tenant instead of refusing outright.
    const [untouchedBrief] = await db.select().from(briefs).where(eq(briefs.id, theirs.id));
    expect(untouchedBrief.status).toBe("new");
    expect(untouchedBrief.contentPieceId).toBeNull();

    const pieces = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, theirTenant.id));
    expect(pieces).toHaveLength(0);

    expect(revalidatePath).not.toHaveBeenCalledWith("/board");
  });

  it("refuses a brief whose status is not new", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    currentTenantId = tenant.id;
    const brief = await seedBrief(tenant.id, { status: "dismissed" });

    const result = await acceptBriefCard(brief.id);

    expect(result.ok).toBe(false);

    const [untouched] = await db.select().from(briefs).where(eq(briefs.id, brief.id));
    expect(untouched.status).toBe("dismissed");
    expect(untouched.contentPieceId).toBeNull();

    const pieces = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
    expect(pieces).toHaveLength(0);
    expect(revalidatePath).not.toHaveBeenCalledWith("/board");
  });
});
