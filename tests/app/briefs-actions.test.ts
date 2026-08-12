import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, briefs, contentPieces, users } from "../../src/db/schema";

const TENANT = "Briefs Actions Test Tenant";
const USER_EMAIL = "briefs-actions-test@example.com";
let currentTenantId = "";
let currentUserId: string | null = null;

// requireSession() returns a NextAuth Session — tenantId lives under `user`,
// per src/types/next-auth.d.ts. Mirror that shape, not a flat one.
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Stores the callback instead of invoking it inline. The real `after` defers
// until the response is finished, which never happens in a test — but the
// previous version of this mock called `fn()` synchronously without awaiting
// it, which raced every test's own assertions against the background
// generateDraftForPiece call: "leaves generation state empty on a freshly
// accepted brief" (below) only passed because its assertions usually — not
// always — won that race by finishing first. Storing the callback here and
// draining it in `afterEach` (after each test's own assertions have already
// run) makes that ordering true by construction: during a test body,
// acceptBrief's generation callback genuinely has not run yet. Draining
// before deleting the tenant also stops the background UPDATE from landing
// after its rows are gone, which previously surfaced as a swallowed
// FK-violation error.
const pendingAfterCallbacks = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    pendingAfterCallbacks.push(fn);
  },
}));

// acceptBrief's `after()` callback calls generateDraftForPiece with no
// generator override, so it falls through to the real generateBriefDraft —
// which calls the real Anthropic API — unless that module is mocked here too.
// `afterEach` above drains and awaits every stored `after()` callback, so an
// unmocked generateBriefDraft would issue a real network request once per
// accept test, every time.
const generateBriefDraft = vi.fn(async (..._args: unknown[]) => ({
  title: "Mock generated title",
  body: "Mock generated body.",
}));
// `generateReleaseDraft` is the release fork's generator. No brief here cites
// shipped work, so the fork never selects it — but `generateDraftForPiece`
// reads the export unconditionally to resolve its default, and a mocked module
// throws on an export it doesn't define. Mocked for the same reason as the one
// above: so nothing in this file can reach a real model.
const generateReleaseDraft = vi.fn(async (..._args: unknown[]) => ({
  title: "Mock release title",
  body: "Mock release body.",
}));
vi.mock("../../src/lib/ai/generation", () => ({
  generateBriefDraft: (...args: unknown[]) => generateBriefDraft(...args),
  generateReleaseDraft: (...args: unknown[]) => generateReleaseDraft(...args),
}));

// Pre-emptive, not currently load-bearing: every brief in this file is a
// blog_post, so generateDraftForPiece's release branch — the only caller of
// reviewAndReconcile — is unreachable today. The first product_update brief
// anyone adds here would otherwise run the REAL reviewer against the Anthropic
// API from a drained after() callback, which is the same trap the generation
// mock above exists for. No test may reach a real model.
vi.mock("../../src/lib/ai/review-draft", () => ({
  reviewAndReconcile: vi.fn(async (draft: { title: string; body: string }) => ({
    finalDraft: draft,
    status: "passed" as const,
    issues: [] as string[],
  })),
}));

import { revalidatePath } from "next/cache";
import { acceptBrief, dismissBrief } from "../../src/app/(dashboard)/briefs/actions";
import { scaffoldBody } from "../../src/lib/briefs/scaffold";
import { runIdeation } from "../../src/lib/briefs/run";

afterEach(async () => {
  // Drain and await every `after()` callback this test scheduled BEFORE
  // tearing down its tenant — otherwise the background generateDraftForPiece
  // write can land after the tenant row is gone.
  await Promise.all(pendingAfterCallbacks.splice(0).map((fn) => fn()));
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  await db.delete(users).where(eq(users.email, USER_EMAIL));
  // Reset so a test that doesn't seed its own user never inherits a stale id
  // from a previous test — the user row it pointed to was just deleted above,
  // and acceptedBy/dismissedBy would otherwise violate their FK on insert.
  currentUserId = null;
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
    const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
    currentUserId = user.id;
    const brief = await seedBrief(tenant.id);

    const result = await acceptBrief(brief.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pieces = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
    expect(pieces).toHaveLength(1);
    expect(pieces[0].id).toBe(result.contentPieceId);
    expect(pieces[0].type).toBe("blog_post");
    expect(pieces[0].status).toBe("brief");
    expect(pieces[0].body).toContain("## Point one");

    const [after] = await db.select().from(briefs).where(eq(briefs.id, brief.id));
    expect(after.status).toBe("accepted");
    expect(after.contentPieceId).toBe(result.contentPieceId);
    expect(after.acceptedAt).toBeInstanceOf(Date);
    // A null acceptedBy would pass silently if no test ever set a real user id.
    expect(after.acceptedBy).toBe(user.id);

    // The sidebar draft count reads /drafts, which would otherwise lag behind
    // an accept until something unrelated revalidated it.
    expect(revalidatePath).toHaveBeenCalledWith("/briefs");
    expect(revalidatePath).toHaveBeenCalledWith("/drafts");
  });

  it("leaves generation state empty on a freshly accepted brief", async () => {
    const tenant = await seedTenant();
    const brief = await seedBrief(tenant.id);

    const result = await acceptBrief(brief.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [piece] = await db
      .select()
      .from(contentPieces)
      .where(eq(contentPieces.id, result.contentPieceId));
    // "brief" means approved, not yet drafted. A null generatedAt is what
    // distinguishes the scaffold from a model-written body.
    expect(piece.status).toBe("brief");
    expect(piece.generatedAt).toBeNull();
    expect(piece.generationError).toBeNull();
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

  // The test above ("is a no-op on an already-accepted brief") awaits the two
  // calls sequentially, so the pre-check alone (brief.status !== "new", read
  // before either transaction starts) rejects the second call — it passes even
  // if the UPDATE's `where(and(eq(briefs.id, briefId), eq(briefs.status,
  // "new")))` loses its status clause entirely.
  //
  // Firing exactly two calls through Promise.all is not enough to prove
  // anything either: on this suite's local, low-latency Postgres, one call's
  // entire pre-check-plus-transaction round trip routinely finishes before the
  // other call's very first (pre-check) query even returns, so two calls
  // still resolve via the ordinary sequential pre-check almost every time —
  // this was verified empirically before writing this test. Ten concurrent
  // calls is what reliably gets multiple calls past the pre-check *together*
  // and into the transaction, so the UPDATE's own status re-check is what has
  // to settle it. Once that happens, the outcome stops being timing-dependent:
  // Postgres row locking serializes the competing UPDATEs, every loser matches
  // zero rows once a winner has committed, and `tx.rollback()` fires for each
  // of them — so *which* call wins is unspecified, but that exactly one wins
  // is not.
  it("under ten simultaneous accepts, exactly one wins and exactly one content piece exists", async () => {
    const tenant = await seedTenant();
    const brief = await seedBrief(tenant.id);

    const results = await Promise.all(Array.from({ length: 10 }, () => acceptBrief(brief.id)));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(9);

    const pieces = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
    expect(pieces).toHaveLength(1);
  });

  it("schedules generation without letting it block or fail the accept", async () => {
    const tenant = await seedTenant();
    const brief = await seedBrief(tenant.id);

    const result = await acceptBrief(brief.id);

    // Accept succeeds regardless of what generation does — that is the whole
    // point of deferring it.
    expect(result.ok).toBe(true);
    const [after] = await db.select().from(briefs).where(eq(briefs.id, brief.id));
    expect(after.status).toBe("accepted");
  });
});

describe("dismissBrief", () => {
  it("writes every dismissal column", async () => {
    const tenant = await seedTenant();
    const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
    currentUserId = user.id;
    const brief = await seedBrief(tenant.id);

    const result = await dismissBrief(brief.id, "already_covered", "We shipped this last week.");
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(briefs).where(eq(briefs.id, brief.id));
    expect(after.status).toBe("dismissed");
    expect(after.dismissReason).toBe("already_covered");
    expect(after.dismissNote).toBe("We shipped this last week.");
    expect(after.dismissedAt).toBeInstanceOf(Date);
    // A null dismissedBy would pass silently if no test ever set a real user id.
    expect(after.dismissedBy).toBe(user.id);
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

describe("dismissal trains the next run", () => {
  it("carries a dismissed brief's title and note into runIdeation's prompt input", async () => {
    const tenant = await seedTenant();
    currentUserId = null;
    const brief = await seedBrief(tenant.id, { title: "Unique Dismiss Title 8f2c1e" });

    const result = await dismissBrief(brief.id, "not_our_voice", "Reads too much like a press release.");
    expect(result.ok).toBe(true);

    // The spec's claim is that writing the dismiss columns is what trains the
    // agent, because run.ts reads them back. Assert on what the mocked
    // ideateFn actually received — not on the columns, which a rename on
    // either side (this write, or run.ts's read) would leave green.
    const ideateFn = vi.fn().mockResolvedValue({ assessment: "x", actions: [] });
    await runIdeation(tenant.id, { database: db, ideateFn });

    expect(ideateFn).toHaveBeenCalledTimes(1);
    const rejected = ideateFn.mock.calls[0][0].context.rejected as string[];
    const entry = rejected.find((r) => r.includes("Unique Dismiss Title 8f2c1e"));
    expect(entry).toBeDefined();
    expect(entry).toContain("not_our_voice");
    expect(entry).toContain("Reads too much like a press release.");
  });
});
