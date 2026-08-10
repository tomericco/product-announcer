import { desc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { contentPieces } from "@/db/schema";
import type { ContentPiece } from "@/lib/publishing/destinations/types";

type Database = typeof defaultDb;

export const BOARD_COLUMNS = ["brief", "draft", "review", "scheduled", "published"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

// Published grows without bound and would otherwise dominate the board;
// /history is the full record. The working columns are never capped —
// hiding work in flight is the one thing a board must not do.
export const PUBLISHED_COLUMN_LIMIT = 20;

export type BoardCard = {
  id: string;
  title: string;
  type: ContentPiece["type"];
  status: BoardColumn;
  assignedTo: string | null;
  scheduledFor: Date | null;
  generationError: string | null;
  generatedAt: Date | null;
  createdAt: Date;
};

export async function readBoard(
  tenantId: string,
  database: Database = defaultDb
): Promise<Record<BoardColumn, BoardCard[]>> {
  const rows = await database
    .select({
      id: contentPieces.id,
      title: contentPieces.title,
      type: contentPieces.type,
      status: contentPieces.status,
      assignedTo: contentPieces.assignedTo,
      scheduledFor: contentPieces.scheduledFor,
      generationError: contentPieces.generationError,
      generatedAt: contentPieces.generatedAt,
      createdAt: contentPieces.createdAt,
    })
    .from(contentPieces)
    .where(eq(contentPieces.tenantId, tenantId))
    // contentPieces has no updatedAt column — an earlier draft of this plan
    // assumed one. createdAt is the closest ordering available; composedAt
    // is deliberately not used, since it means when the body was first
    // composed, not when the row last changed.
    .orderBy(desc(contentPieces.createdAt));

  // Seeded with every column so an empty column is `[]` rather than absent —
  // a missing key would render as a missing column, not an empty one.
  const board: Record<BoardColumn, BoardCard[]> = {
    brief: [],
    draft: [],
    review: [],
    scheduled: [],
    published: [],
  };

  const isBoardColumn = (status: string): status is BoardColumn =>
    (BOARD_COLUMNS as readonly string[]).includes(status);

  for (const row of rows) {
    // `archived` (and any other status outside the five board columns) has
    // no column to land in and is intentionally excluded from the board.
    if (!isBoardColumn(row.status)) continue;
    board[row.status].push({ ...row, status: row.status });
  }

  // Sliced to the limit AFTER ordering (newest first), so the newest survive.
  board.published = board.published.slice(0, PUBLISHED_COLUMN_LIMIT);

  return board;
}
