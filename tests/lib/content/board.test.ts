import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces, users, tenantMembers } from "../../../src/db/schema";
import {
  readBoard,
  BOARD_COLUMNS,
  PUBLISHED_COLUMN_LIMIT,
  canMove,
  moveContentPiece,
  assignContentPiece,
} from "../../../src/lib/content/board";

const TENANT = "Board Read Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

async function seedPiece(tenantId: string, overrides: Partial<typeof contentPieces.$inferInsert> = {}) {
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId, type: "blog_post", title: "A piece", body: "b", ...overrides })
    .returning();
  return piece;
}

describe("readBoard", () => {
  it("returns every column, empty ones included", async () => {
    const tenant = await seedTenant();
    const board = await readBoard(tenant.id, db);
    // A column missing from the object would render as a missing column, not
    // an empty one — the board must always show the whole pipeline.
    expect(Object.keys(board).sort()).toEqual([...BOARD_COLUMNS].sort());
    for (const c of BOARD_COLUMNS) expect(board[c]).toEqual([]);
  });

  it("groups pieces by status", async () => {
    const tenant = await seedTenant();
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
    const tenant = await seedTenant();
    for (let i = 0; i < PUBLISHED_COLUMN_LIMIT + 4; i++) {
      await seedPiece(tenant.id, { title: `P${i}`, status: "published" });
    }
    const board = await readBoard(tenant.id, db);
    // Published grows without bound and would otherwise dominate the board;
    // /history is the full record.
    expect(board.published).toHaveLength(PUBLISHED_COLUMN_LIMIT);
  });

  it("does not cap the working columns", async () => {
    const tenant = await seedTenant();
    for (let i = 0; i < PUBLISHED_COLUMN_LIMIT + 4; i++) {
      await seedPiece(tenant.id, { title: `D${i}`, status: "draft" });
    }
    const board = await readBoard(tenant.id, db);
    // Hiding work in flight is the one thing a board must never do.
    expect(board.draft).toHaveLength(PUBLISHED_COLUMN_LIMIT + 4);
  });

  it("returns only the calling tenant's pieces", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    await seedPiece(mine.id, { title: "Mine", status: "draft" });
    await seedPiece(other.id, { title: "Theirs", status: "draft" });

    const board = await readBoard(mine.id, db);
    expect(board.draft.map((c) => c.title)).toEqual(["Mine"]);
  });

  it("carries the fields a card renders", async () => {
    const tenant = await seedTenant();
    const when = new Date("2026-09-01T09:00:00Z");
    await seedPiece(tenant.id, { status: "scheduled", scheduledFor: when, generationError: "warned" });

    const [card] = (await readBoard(tenant.id, db)).scheduled;
    expect(card.scheduledFor?.toISOString()).toBe(when.toISOString());
    expect(card.generationError).toBe("warned");
  });

  it("filters by assignee BEFORE capping the published column, not after", async () => {
    const tenant = await seedTenant();
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
    const tenant = await seedTenant();
    const [member] = await db.insert(users).values({ email: `board-unassigned-${Date.now()}@example.com`, name: "M" }).returning();
    await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: member.id, role: "member" });
    await seedPiece(tenant.id, { title: "Assigned", status: "draft", assignedTo: member.id });
    await seedPiece(tenant.id, { title: "Unassigned", status: "draft" });

    const board = await readBoard(tenant.id, db, { assignedTo: "unassigned" });
    expect(board.draft.map((c) => c.title)).toEqual(["Unassigned"]);
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
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, { status: "draft" });

    expect(await moveContentPiece(piece.id, tenant.id, "review", {}, db)).toEqual({ ok: true });
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("review");
  });

  it("refuses a move the rules forbid and changes nothing", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, { status: "draft" });

    // The client renders no such drop target. That is not a guarantee.
    const result = await moveContentPiece(piece.id, tenant.id, "published", {}, db);
    expect(result.ok).toBe(false);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
  });

  it("refuses to drag an ungenerated piece into draft", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, { status: "brief", body: "SCAFFOLD" });

    const result = await moveContentPiece(piece.id, tenant.id, "draft", {}, db);
    expect(result.ok).toBe(false);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("brief");
    expect(after.body).toBe("SCAFFOLD");
  });

  it("requires a scheduled time when entering scheduled", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, { status: "review" });

    expect((await moveContentPiece(piece.id, tenant.id, "scheduled", {}, db)).ok).toBe(false);

    const when = new Date("2026-09-01T09:00:00Z");
    expect(await moveContentPiece(piece.id, tenant.id, "scheduled", { scheduledFor: when }, db)).toEqual({ ok: true });
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.scheduledFor?.toISOString()).toBe(when.toISOString());
  });

  it("clears the scheduled time on the way out", async () => {
    const tenant = await seedTenant();
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
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedPiece(other.id, { status: "draft" });

    expect((await moveContentPiece(theirs.id, mine.id, "review", {}, db)).ok).toBe(false);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, theirs.id));
    expect(after.status).toBe("draft");
  });

  it("refuses a move whose source status is \"archived\" — no board column to leave from", async () => {
    const tenant = await seedTenant();
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
    const tenant = await seedTenant();
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
    const tenant = await seedTenant();
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
