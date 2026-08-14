import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces, users, tenantMembers, briefs } from "../../../src/db/schema";
import {
  readBoard,
  BOARD_COLUMNS,
  BRIEF_COLUMN,
  PUBLISHED_COLUMN_LIMIT,
  canMove,
  moveContentPiece,
  assignContentPiece,
} from "../../../src/lib/content/board";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "Board Read Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

async function seedPiece(tenantId: string, overrides: Partial<typeof contentPieces.$inferInsert> = {}) {
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId, type: "blog_post", title: "A piece", body: "b", ...overrides })
    .returning();
  return piece;
}

async function seedBrief(tenantId: string, overrides: Partial<typeof briefs.$inferInsert> = {}) {
  const [brief] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin: "agent",
      contentType: "blog_post",
      title: "A brief",
      angle: "an angle",
      whyNow: "because",
      suggestedChannel: "blog",
      score: 0.8,
      lastEvidenceAt: new Date(),
      ...overrides,
    })
    .returning();
  return brief;
}

describe("readBoard", () => {
  it("returns every column, empty ones included", async () => {
    const tenant = await seedTenant(TENANT);
    const board = await readBoard(tenant.id, db);
    // A column missing from the object would render as a missing column, not
    // an empty one — the board must always show the whole pipeline. The brief
    // column is keyed separately from the five content-piece statuses because
    // it holds a different object type.
    expect(Object.keys(board).sort()).toEqual([BRIEF_COLUMN, ...BOARD_COLUMNS].sort());
    for (const c of BOARD_COLUMNS) expect(board[c]).toEqual([]);
    expect(board[BRIEF_COLUMN]).toEqual([]);
  });

  it("groups pieces by status", async () => {
    const tenant = await seedTenant(TENANT);
    await seedPiece(tenant.id, { title: "B", status: "brief" });
    await seedPiece(tenant.id, { title: "D", status: "draft" });
    await seedPiece(tenant.id, { title: "R", status: "review" });

    const board = await readBoard(tenant.id, db);
    expect(board.brief.map((c) => c.title)).toEqual(["B"]);
    expect(board.draft.map((c) => c.title)).toEqual(["D"]);
    expect(board.review.map((c) => c.title)).toEqual(["R"]);
    expect(board.scheduled).toEqual([]);
  });

  it("caps the published column", async () => {
    const tenant = await seedTenant(TENANT);
    for (let i = 0; i < PUBLISHED_COLUMN_LIMIT + 4; i++) {
      await seedPiece(tenant.id, { title: `P${i}`, status: "published" });
    }
    const board = await readBoard(tenant.id, db);
    // Published grows without bound and would otherwise dominate the board;
    // /history is the full record.
    expect(board.published).toHaveLength(PUBLISHED_COLUMN_LIMIT);
  });

  it("does not cap the working columns", async () => {
    const tenant = await seedTenant(TENANT);
    for (let i = 0; i < PUBLISHED_COLUMN_LIMIT + 4; i++) {
      await seedPiece(tenant.id, { title: `D${i}`, status: "draft" });
    }
    const board = await readBoard(tenant.id, db);
    // Hiding work in flight is the one thing a board must never do.
    expect(board.draft).toHaveLength(PUBLISHED_COLUMN_LIMIT + 4);
  });

  it("returns only the calling tenant's pieces", async () => {
    const mine = await seedTenant(TENANT);
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    await seedPiece(mine.id, { title: "Mine", status: "draft" });
    await seedPiece(other.id, { title: "Theirs", status: "draft" });

    const board = await readBoard(mine.id, db);
    expect(board.draft.map((c) => c.title)).toEqual(["Mine"]);
  });

  it("carries the fields a card renders", async () => {
    const tenant = await seedTenant(TENANT);
    const when = new Date("2026-09-01T09:00:00Z");
    await seedPiece(tenant.id, {
      status: "scheduled",
      scheduledFor: when,
      generationError: "warned",
      generationStep: "generating",
    });

    const [card] = (await readBoard(tenant.id, db)).scheduled;
    expect(card.scheduledFor?.toISOString()).toBe(when.toISOString());
    expect(card.generationError).toBe("warned");
    expect(card.generationStep).toBe("generating");
  });

  it("filters by assignee BEFORE capping the published column, not after", async () => {
    const tenant = await seedTenant(TENANT);
    const [member] = await db.insert(users).values({ email: `board-filter-${Date.now()}@example.com`, name: "M" }).returning();
    await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: member.id, role: "member" });

    // `member`'s one piece is seeded FIRST (so it is the OLDEST row), then
    // more than PUBLISHED_COLUMN_LIMIT newer pieces belong to someone else.
    // If the filter ran AFTER the published slice (on just the 20 newest
    // overall), "Mine" would already have fallen out of that top 20 before
    // the filter ever got to look at it, and the column would come back
    // empty instead of showing the one piece that actually matches.
    await seedPiece(tenant.id, { title: "Mine", status: "published", assignedTo: member.id });
    for (let i = 0; i < PUBLISHED_COLUMN_LIMIT + 4; i++) {
      await seedPiece(tenant.id, { title: `P${i}`, status: "published" });
    }

    const board = await readBoard(tenant.id, db, { assignedTo: member.id });
    expect(board.published.map((c) => c.title)).toEqual(["Mine"]);
  });

  it("filters to unassigned pieces with the \"unassigned\" sentinel", async () => {
    const tenant = await seedTenant(TENANT);
    const [member] = await db.insert(users).values({ email: `board-unassigned-${Date.now()}@example.com`, name: "M" }).returning();
    await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: member.id, role: "member" });
    await seedPiece(tenant.id, { title: "Assigned", status: "draft", assignedTo: member.id });
    await seedPiece(tenant.id, { title: "Unassigned", status: "draft" });

    const board = await readBoard(tenant.id, db, { assignedTo: "unassigned" });
    expect(board.draft.map((c) => c.title)).toEqual(["Unassigned"]);
  });

  it("excludes archived pieces — there is no board column for them", async () => {
    const tenant = await seedTenant(TENANT);
    await seedPiece(tenant.id, { title: "Archived", status: "archived" });
    await seedPiece(tenant.id, { title: "Live", status: "draft" });

    const board = await readBoard(tenant.id, db);
    const titles = BOARD_COLUMNS.flatMap((c) => board[c].map((card) => card.title));
    expect(titles).toEqual(["Live"]);
  });
});

describe("readBoard — the brief column", () => {
  it("returns the tenant's new briefs, highest score first", async () => {
    const tenant = await seedTenant(TENANT);
    const low = await seedBrief(tenant.id, { title: "Low", score: 0.4 });
    const high = await seedBrief(tenant.id, { title: "High", score: 0.9 });

    const board = await readBoard(tenant.id, db);
    expect(board[BRIEF_COLUMN].map((c) => c.id)).toEqual([high.id, low.id]);
    expect(board[BRIEF_COLUMN][0]).toEqual({
      kind: "brief",
      id: high.id,
      title: "High",
      contentType: "blog_post",
      score: 0.9,
      status: "new",
    });
  });

  it("keeps briefs out of the content-piece columns, and pieces out of the brief column", async () => {
    const tenant = await seedTenant(TENANT);
    await seedBrief(tenant.id, { title: "A brief" });
    // A piece with status "brief" is the accept-time scaffold — the column
    // labelled Generating. It is a different object from the brief above and
    // must not land in the brief column.
    const piece = await seedPiece(tenant.id, { title: "Generating", status: "brief" });

    const board = await readBoard(tenant.id, db);
    expect(board.brief.map((c) => c.id)).toEqual([piece.id]);
    expect(board.brief.every((c) => c.kind === "piece")).toBe(true);
    expect(board[BRIEF_COLUMN].map((c) => c.title)).toEqual(["A brief"]);
  });

  it("excludes an accepted brief — its content piece is already on the board", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id, { title: "The draft", status: "draft" });
    const accepted = await seedBrief(tenant.id, {
      title: "Accepted",
      status: "accepted",
      contentPieceId: piece.id,
      acceptedAt: new Date(),
    });
    const open = await seedBrief(tenant.id, { title: "Still open" });

    const board = await readBoard(tenant.id, db);
    const ids = board[BRIEF_COLUMN].map((c) => c.id);
    // Showing both the accepted brief and the piece it produced would
    // double-count the same work in two columns.
    expect(ids).not.toContain(accepted.id);
    expect(ids).toEqual([open.id]);
    expect(board.draft.map((c) => c.id)).toEqual([piece.id]);
  });

  it("excludes dismissed and expired briefs — decisions already made", async () => {
    const tenant = await seedTenant(TENANT);
    const dismissed = await seedBrief(tenant.id, {
      title: "Dismissed",
      status: "dismissed",
      dismissReason: "off_topic",
      dismissedAt: new Date(),
    });
    const expired = await seedBrief(tenant.id, { title: "Expired", status: "expired" });

    const board = await readBoard(tenant.id, db);
    const ids = board[BRIEF_COLUMN].map((c) => c.id);
    expect(ids).not.toContain(dismissed.id);
    expect(ids).not.toContain(expired.id);
    expect(ids).toEqual([]);
  });

  it("returns only the calling tenant's briefs", async () => {
    const mine = await seedTenant(TENANT);
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const ours = await seedBrief(mine.id, { title: "Ours" });
    const theirs = await seedBrief(other.id, { title: "Theirs" });

    const board = await readBoard(mine.id, db);
    const ids = board[BRIEF_COLUMN].map((c) => c.id);
    // By id, not by an empty result: an empty column would also "pass" if the
    // read were broken in a way that returned nothing at all.
    expect(ids).toContain(ours.id);
    expect(ids).not.toContain(theirs.id);
  });

  it("ignores the assignee filter — a brief has no assignee", async () => {
    const tenant = await seedTenant(TENANT);
    const [member] = await db.insert(users).values({ email: `board-brief-${Date.now()}@example.com`, name: "M" }).returning();
    await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: member.id, role: "member" });
    const brief = await seedBrief(tenant.id, { title: "Unfiltered" });

    // assignedTo is a content-piece concept. The read returns the briefs
    // either way; the board's UI explains the mismatch rather than silently
    // emptying the column (see the spec).
    const board = await readBoard(tenant.id, db, { assignedTo: member.id });
    expect(board[BRIEF_COLUMN].map((c) => c.id)).toEqual([brief.id]);
  });
});

describe("canMove", () => {
  it("allows movement among the planning states", () => {
    expect(canMove("draft", "review")).toBe(true);
    expect(canMove("review", "scheduled")).toBe(true);
    expect(canMove("scheduled", "review")).toBe(true);
    expect(canMove("review", "draft")).toBe(true);
    // draft <-> scheduled skips review in both directions, deliberately: the
    // three planning states are a full mesh, not a chain that must pass
    // through review. review is advisory — a label a human can skip — not a
    // gate a card must clear before reaching scheduled.
    expect(canMove("draft", "scheduled")).toBe(true);
    expect(canMove("scheduled", "draft")).toBe(true);
  });

  it("never allows a move into published", () => {
    // Publishing dispatches to external destinations and has guards a board
    // move would bypass. It stays the explicit action on the draft page.
    for (const from of ["brief", "draft", "review", "scheduled"] as const) {
      expect(canMove(from, "published")).toBe(false);
    }
  });

  it("never allows a move into or out of brief", () => {
    // A brief-status body is the accept-time scaffold. Moving it to draft
    // would present that scaffold as a finished draft.
    for (const to of ["draft", "review", "scheduled"] as const) {
      expect(canMove("brief", to)).toBe(false);
    }
    for (const from of ["draft", "review", "scheduled"] as const) {
      expect(canMove(from, "brief")).toBe(false);
    }
  });

  it("never allows a move out of published", () => {
    for (const to of ["draft", "review", "scheduled"] as const) {
      expect(canMove("published", to)).toBe(false);
    }
  });
});

describe("moveContentPiece", () => {
  it("moves a draft into review", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id, { status: "draft" });

    expect(await moveContentPiece(piece.id, tenant.id, "review", {}, db)).toEqual({ ok: true });
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("review");
  });

  it("refuses a move the rules forbid and changes nothing", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id, { status: "draft" });

    // The client renders no such drop target. That is not a guarantee.
    const result = await moveContentPiece(piece.id, tenant.id, "published", {}, db);
    expect(result.ok).toBe(false);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
  });

  it("refuses to drag an ungenerated piece into draft", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id, { status: "brief", body: "SCAFFOLD" });

    const result = await moveContentPiece(piece.id, tenant.id, "draft", {}, db);
    expect(result.ok).toBe(false);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("brief");
    expect(after.body).toBe("SCAFFOLD");
  });

  it("requires a scheduled time when entering scheduled", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id, { status: "review" });

    expect((await moveContentPiece(piece.id, tenant.id, "scheduled", {}, db)).ok).toBe(false);

    const when = new Date("2026-09-01T09:00:00Z");
    expect(await moveContentPiece(piece.id, tenant.id, "scheduled", { scheduledFor: when }, db)).toEqual({ ok: true });
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.scheduledFor?.toISOString()).toBe(when.toISOString());
  });

  it("clears the scheduled time on the way out", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id, {
      status: "scheduled",
      scheduledFor: new Date("2026-09-01T09:00:00Z"),
    });

    await moveContentPiece(piece.id, tenant.id, "review", {}, db);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    // The calendar reads scheduledFor. A piece no longer scheduled must not
    // keep a date the calendar would still draw.
    expect(after.scheduledFor).toBeNull();
  });

  it("refuses a piece belonging to another tenant", async () => {
    const mine = await seedTenant(TENANT);
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedPiece(other.id, { status: "draft" });

    expect((await moveContentPiece(theirs.id, mine.id, "review", {}, db)).ok).toBe(false);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, theirs.id));
    expect(after.status).toBe("draft");
  });

  it("refuses a move whose source status is \"archived\" — no board column to leave from", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id, { status: "archived" });

    const result = await moveContentPiece(piece.id, tenant.id, "review", {}, db);
    expect(result.ok).toBe(false);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("archived");
  });
});

describe("assignContentPiece", () => {
  async function seedMember(tenantId: string, email: string) {
    const [user] = await db.insert(users).values({ email, name: "M" }).returning();
    await db.insert(tenantMembers).values({ tenantId, userId: user.id, role: "member" });
    return user;
  }

  it("assigns a workspace member, and unassigns with null", async () => {
    const tenant = await seedTenant(TENANT);
    const member = await seedMember(tenant.id, `m${Date.now()}@example.com`);
    const piece = await seedPiece(tenant.id, { status: "draft" });

    expect(await assignContentPiece(piece.id, tenant.id, member.id, db)).toEqual({ ok: true });
    let [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.assignedTo).toBe(member.id);

    expect(await assignContentPiece(piece.id, tenant.id, null, db)).toEqual({ ok: true });
    [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.assignedTo).toBeNull();
  });

  it("refuses a user who is not in the workspace", async () => {
    const tenant = await seedTenant(TENANT);
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const outsider = await seedMember(other.id, `o${Date.now()}@example.com`);
    const piece = await seedPiece(tenant.id, { status: "draft" });

    // The user id comes from a form. Assigning an outsider would put a piece
    // in a queue belonging to someone who cannot see the workspace.
    expect((await assignContentPiece(piece.id, tenant.id, outsider.id, db)).ok).toBe(false);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.assignedTo).toBeNull();
  });
});
