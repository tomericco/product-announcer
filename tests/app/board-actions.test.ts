import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, contentPieces, briefs, briefSignals, signals } from "../../src/db/schema";

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
import {
  moveCard,
  acceptBriefCard,
  deleteCard,
  deleteBriefCard,
} from "../../src/app/(dashboard)/board/actions";

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

/**
 * `deleteCard` is Delete on a content-piece card. It is a wrapper around
 * `deleteDraft` (src/app/(dashboard)/drafts/actions.ts), which already owns
 * the tenant scoping, the published refusal and the atomic-update revert —
 * so these tests assert the outcomes reached FROM THE BOARD, not that the
 * wrapper called a function. What `deleteDraft` does on its own is pinned in
 * tests/app/drafts/reject-delete-actions.test.ts; what is asserted here is
 * that the board's entry point inherits all of it, and turns a throw into a
 * refusal the board can toast.
 */
describe("deleteCard", () => {
  async function pieceRow(id: string) {
    const [row] = await db.select().from(contentPieces).where(eq(contentPieces.id, id));
    return row;
  }

  it("deletes a draft piece", async () => {
    const { piece } = await seed("draft");

    const result = await deleteCard(piece.id);

    expect(result).toEqual({ ok: true });
    expect(await pieceRow(piece.id)).toBeUndefined();
    expect(revalidatePath).toHaveBeenCalledWith("/board");
  });

  it("refuses a published piece and leaves the row intact", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    currentTenantId = tenant.id;
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B", status: "published", publishedAt: new Date() })
      .returning();

    const result = await deleteCard(piece.id);

    expect(result.ok).toBe(false);
    expect((await pieceRow(piece.id))?.status).toBe("published");
    expect(revalidatePath).not.toHaveBeenCalledWith("/board");
  });

  // The deliberate asymmetry with `assertDraftEditable`: a piece whose
  // generation can never succeed has no other exit, and on the board it is a
  // card sitting in Draft with a "Generation failed" badge.
  it('deletes a "brief"-status piece — a generation that can never succeed needs a way out', async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    currentTenantId = tenant.id;
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B", status: "brief", generationError: "boom" })
      .returning();

    const result = await deleteCard(piece.id);

    expect(result).toEqual({ ok: true });
    expect(await pieceRow(piece.id)).toBeUndefined();
  });

  // "Delete at any review" — `deleteDraft` never consults `reviewStatus`, so
  // a piece the reviewer failed is as deletable as one it passed. Pinned
  // here rather than trusted, because it is a requirement of this spec that
  // no line of code states.
  it("deletes regardless of reviewStatus", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    currentTenantId = tenant.id;
    const [failed] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "F", body: "B", status: "review", reviewStatus: "failed" })
      .returning();
    const [passed] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "P", body: "B", status: "review", reviewStatus: "passed" })
      .returning();

    expect(await deleteCard(failed.id)).toEqual({ ok: true });
    expect(await deleteCard(passed.id)).toEqual({ ok: true });
    expect(await pieceRow(failed.id)).toBeUndefined();
    expect(await pieceRow(passed.id)).toBeUndefined();
  });

  it("is tenant-scoped: another tenant's piece id deletes nothing", async () => {
    const [mine] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    currentTenantId = mine.id;
    const [theirTenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    const [theirs] = await db
      .insert(contentPieces)
      .values({ tenantId: theirTenant.id, title: "Theirs", body: "B", status: "draft" })
      .returning();

    const result = await deleteCard(theirs.id);

    expect(result.ok).toBe(false);
    // By id. An empty result under MY tenant would pass even if the row had
    // been deleted from theirs.
    expect(await pieceRow(theirs.id)).toBeDefined();
    expect(revalidatePath).not.toHaveBeenCalledWith("/board");
  });
});

/**
 * `deleteBriefCard` is Delete on a brief card — a genuinely new destructive
 * action, unlike `deleteCard` above. It delegates to `deleteBrief`
 * (src/app/(dashboard)/briefs/actions.ts), which is where the tenant scope
 * and the accepted-brief refusal live.
 */
describe("deleteBriefCard", () => {
  async function briefRow(id: string) {
    const [row] = await db.select().from(briefs).where(eq(briefs.id, id));
    return row;
  }

  it("deletes the brief row", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    currentTenantId = tenant.id;
    const brief = await seedBrief(tenant.id);

    const result = await deleteBriefCard(brief.id);

    expect(result).toEqual({ ok: true });
    expect(await briefRow(brief.id)).toBeUndefined();
    expect(revalidatePath).toHaveBeenCalledWith("/board");
  });

  it("is tenant-scoped: another tenant's brief id deletes nothing", async () => {
    const [mine] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    currentTenantId = mine.id;
    const [theirTenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    const theirs = await seedBrief(theirTenant.id);

    const result = await deleteBriefCard(theirs.id);

    expect(result.ok).toBe(false);
    // By id, for the same reason acceptBriefCard's tenant test asserts by
    // id: "nothing of mine changed" is not the claim being made here.
    const survivor = await briefRow(theirs.id);
    expect(survivor).toBeDefined();
    expect(survivor.status).toBe("new");
    expect(revalidatePath).not.toHaveBeenCalledWith("/board");
  });

  // The decision recorded in `deleteBrief`'s doc comment. An accepted brief
  // owns a content piece via `contentPieceId`; deleting the brief would
  // leave that piece with no traceable commission and erase the record that
  // a human accepted it. Refused rather than cascaded.
  it("refuses an accepted brief, leaving it and its content piece intact", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    currentTenantId = tenant.id;
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B", status: "draft" })
      .returning();
    const brief = await seedBrief(tenant.id, {
      status: "accepted",
      contentPieceId: piece.id,
      acceptedAt: new Date(),
    });

    const result = await deleteBriefCard(brief.id);

    expect(result.ok).toBe(false);
    expect(await briefRow(brief.id)).toBeDefined();
    const [survivingPiece] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(survivingPiece).toBeDefined();
  });

  // `brief_signals.briefId` is ON DELETE cascade, so the join rows go with
  // the brief and the signals themselves — the durable evidence — stay.
  // Asserted rather than assumed: this is the half of the delete that no
  // line of application code performs.
  it("takes its brief_signals join rows with it and leaves the signals themselves", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    currentTenantId = tenant.id;
    const brief = await seedBrief(tenant.id);
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "market_news",
        externalId: `delete-brief-card-${brief.id}`,
        title: "A competitor shipped multilingual tooling",
        occurredAt: new Date(),
      })
      .returning();
    await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });

    expect(await deleteBriefCard(brief.id)).toEqual({ ok: true });

    const joins = await db.select().from(briefSignals).where(eq(briefSignals.signalId, signal.id));
    expect(joins).toHaveLength(0);
    const [survivingSignal] = await db.select().from(signals).where(eq(signals.id, signal.id));
    expect(survivingSignal).toBeDefined();
  });
});
