import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces } from "../../../src/db/schema";
import { readBoard, BOARD_COLUMNS, PUBLISHED_COLUMN_LIMIT } from "../../../src/lib/content/board";

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
});
