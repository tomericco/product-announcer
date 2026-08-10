import { and, desc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { contentPieces, tenantMembers } from "@/db/schema";
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

// `contentPieces.status` includes `archived`, which is not a board column
// (see BOARD_COLUMNS). Shared by readBoard (to skip archived rows) and
// moveContentPiece (to type-narrow a loaded piece's status) instead of each
// asserting the narrower type on its own.
const isBoardColumn = (status: string): status is BoardColumn =>
  (BOARD_COLUMNS as readonly string[]).includes(status);

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

export type MoveResult = { ok: true } | { ok: false; error: string };

// Explicit allowed-pairs table, not a negation list — a negation list
// silently permits whatever nobody thought to forbid. `draft`, `review`, and
// `scheduled` are the planning states a human owns and can freely move a
// card between; `brief` (the accept-time scaffold, left only by generation)
// and `published` (already shipped, entered only through `publishDraft`'s
// own guards) are excluded from both sides.
const ALLOWED_MOVES: ReadonlySet<`${BoardColumn}:${BoardColumn}`> = new Set([
  "draft:review",
  "draft:scheduled",
  "review:draft",
  "review:scheduled",
  "scheduled:draft",
  "scheduled:review",
]);

export function canMove(from: BoardColumn, to: BoardColumn): boolean {
  return ALLOWED_MOVES.has(`${from}:${to}`);
}

export async function moveContentPiece(
  contentPieceId: string,
  tenantId: string,
  to: BoardColumn,
  opts: { scheduledFor?: Date | null } = {},
  database: Database = defaultDb
): Promise<MoveResult> {
  const [piece] = await database
    .select({ id: contentPieces.id, status: contentPieces.status })
    .from(contentPieces)
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, tenantId)));

  if (!piece) {
    return { ok: false, error: "Content piece not found." };
  }

  if (!isBoardColumn(piece.status)) {
    // archived (or any future non-board status) has no row in ALLOWED_MOVES
    // and no board column to move into or out of.
    return { ok: false, error: `Cannot move a piece from ${piece.status} to ${to}.` };
  }
  const from = piece.status;
  if (!canMove(from, to)) {
    return { ok: false, error: `Cannot move a piece from ${from} to ${to}.` };
  }

  if (to === "scheduled" && !opts.scheduledFor) {
    return { ok: false, error: "A scheduled time is required to move a piece into scheduled." };
  }

  // Any move away from scheduled clears scheduledFor — the calendar reads
  // that column directly and must never draw a piece that is no longer
  // scheduled. Only "scheduled" itself carries a value.
  const scheduledFor = to === "scheduled" ? (opts.scheduledFor ?? null) : null;

  // No updatedAt write here — contentPieces has no such column; status and
  // scheduledFor (cleared above on the way out of scheduled) are the only
  // fields a move touches.
  await database
    .update(contentPieces)
    .set({ status: to, scheduledFor })
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, tenantId)));

  return { ok: true };
}

export async function assignContentPiece(
  contentPieceId: string,
  tenantId: string,
  userId: string | null,
  database: Database = defaultDb
): Promise<MoveResult> {
  const [piece] = await database
    .select({ id: contentPieces.id })
    .from(contentPieces)
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, tenantId)));

  if (!piece) {
    return { ok: false, error: "Content piece not found." };
  }

  if (userId !== null) {
    // The user id arrives from a form. Without this check, assigning an
    // outsider would put the piece in a queue belonging to someone who
    // cannot see the workspace it lives in.
    const [membership] = await database
      .select({ userId: tenantMembers.userId })
      .from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)));

    if (!membership) {
      return { ok: false, error: "That user is not a member of this workspace." };
    }
  }

  await database
    .update(contentPieces)
    .set({ assignedTo: userId })
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, tenantId)));

  return { ok: true };
}
