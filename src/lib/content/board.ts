import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { briefs, contentPieces, tenantMembers, type Brief } from "@/db/schema";
import type { ContentPiece } from "@/lib/publishing/destinations/types";
import type { DraftStepKey } from "@/lib/drafting/draft-progress";

type Database = typeof defaultDb;

// Every one of these IS a `contentPieces.status` — the type doubles as the
// status enum for moveContentPiece and ALLOWED_MOVES, so nothing may join it
// that a piece cannot actually be. `brief` here is the accept-time scaffold a
// piece sits in while it generates; it is a status the board groups by, but
// NOT a column of its own — see BOARD_DISPLAY_COLUMNS.
export const BOARD_COLUMNS = ["brief", "draft", "review", "scheduled", "published"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

// The one column that is not a content-piece status. Kept out of
// BOARD_COLUMNS deliberately: adding it there would widen `BoardColumn`, and
// `BoardColumn` is what moveContentPiece writes into `contentPieces.status`
// and what ALLOWED_MOVES is keyed by — a value no piece can hold has no
// business in either.
export const BRIEF_COLUMN = "briefs" as const;
export type BriefColumn = typeof BRIEF_COLUMN;

// The `brief` STATUS, which is not a column. A piece holds it for about the
// length of one generation, and it renders inside the Draft column beside
// the finished drafts — so it must be dropped from the display order while
// staying exactly where it is in BOARD_COLUMNS, which is the move rules'
// alphabet.
const GENERATING_STATUS = "brief" satisfies BoardColumn;

/** A rendered column: the brief column, or a piece status that has one. */
export type DisplayColumn = BriefColumn | Exclude<BoardColumn, typeof GENERATING_STATUS>;

// Display order, Brief first — and Draft is now the only column holding two
// populations: the pieces generating from accepted briefs, and finished
// drafts. Derived from BOARD_COLUMNS rather than written out again, so a new
// status gets a column without anyone having to remember this line.
export const BOARD_DISPLAY_COLUMNS: readonly DisplayColumn[] = [
  BRIEF_COLUMN,
  ...BOARD_COLUMNS.filter((c): c is Exclude<BoardColumn, typeof GENERATING_STATUS> => c !== GENERATING_STATUS),
];

// Published grows without bound and would otherwise dominate the board;
// /history is the full record. The working columns are never capped —
// hiding work in flight is the one thing a board must not do.
export const PUBLISHED_COLUMN_LIMIT = 20;

export type BoardCard = {
  // The discriminant. The board carries two object types now, and this is
  // what keeps a brief id from ever reaching moveContentPiece or a piece id
  // from reaching acceptance — the alternative, one card type with nullable
  // fields, would scatter that distinction across runtime checks in the UI.
  kind: "piece";
  id: string;
  title: string;
  type: ContentPiece["type"];
  status: BoardColumn;
  assignedTo: string | null;
  scheduledFor: Date | null;
  generationError: string | null;
  generatedAt: Date | null;
  // Free text in the database (see the schema comment on the column); cast
  // the same way readGenerationProgress does, tolerating a key this build
  // does not recognize rather than asserting it away.
  generationStep: DraftStepKey | null;
  createdAt: Date;
};

// A commission, not a draft: no assignee, no schedule, no generation state,
// and its id belongs to `briefs`, not `contentPieces`. It links to the brief
// editor at /briefs/[id]; accepting it is a separate transition.
export type BoardBriefCard = {
  kind: "brief";
  id: string;
  title: string;
  contentType: Brief["contentType"];
  score: number;
  status: Brief["status"];
};

// The five status columns hold pieces; the brief column holds briefs. Written
// as two record halves rather than one `Record<…, (BoardCard | BoardBriefCard)[]>`
// so a consumer reading `board.draft` never has to narrow a card that cannot
// be a brief in the first place.
export type Board = Record<BoardColumn, BoardCard[]> & Record<BriefColumn, BoardBriefCard[]>;

// `contentPieces.status` includes `archived`, which is not a board column
// (see BOARD_COLUMNS). Shared by readBoard (to skip archived rows) and
// moveContentPiece (to type-narrow a loaded piece's status) instead of each
// asserting the narrower type on its own.
const isBoardColumn = (status: string): status is BoardColumn =>
  (BOARD_COLUMNS as readonly string[]).includes(status);

export async function readBoard(
  tenantId: string,
  database: Database = defaultDb,
  // Applied BEFORE the published-column slice below, not after — filtering
  // post-slice would show only a filtered share of the already-capped 20
  // newest published pieces while the count still reads as if it were a
  // total. `assignedTo` narrows to that exact member; `"unassigned"` narrows
  // to a null assignedTo. Left undefined, every piece for the tenant counts.
  //
  // It does NOT filter the brief column: `assignedTo` is a content-piece
  // concept and a brief has no assignee. The briefs come back either way and
  // the board explains the mismatch, rather than a column silently emptying
  // itself for a filter it cannot honour. Note this makes the two populations
  // the Draft column renders behave differently under a filter — the pieces
  // in `board.brief` (mid-generation, rendered in Draft) obey it here, the
  // briefs (rendered in Brief) never do — which is exactly what the column's
  // explanation is for.
  opts: { assignedTo?: string | "unassigned" } = {}
): Promise<Board> {
  // Two tables, one board. Fine at this size; the brief column is the natural
  // thing to paginate first if it ever isn't.
  const [rows, briefRows] = await Promise.all([
    database
      .select({
        id: contentPieces.id,
        title: contentPieces.title,
        type: contentPieces.type,
        status: contentPieces.status,
        assignedTo: contentPieces.assignedTo,
        scheduledFor: contentPieces.scheduledFor,
        generationError: contentPieces.generationError,
        generatedAt: contentPieces.generatedAt,
        generationStep: contentPieces.generationStep,
        createdAt: contentPieces.createdAt,
      })
      .from(contentPieces)
      .where(eq(contentPieces.tenantId, tenantId))
      // contentPieces has no updatedAt column — an earlier draft of this plan
      // assumed one. createdAt is the closest ordering available; composedAt
      // is deliberately not used, since it means when the body was first
      // composed, not when the row last changed.
      .orderBy(desc(contentPieces.createdAt)),
    database
      .select({
        id: briefs.id,
        title: briefs.title,
        contentType: briefs.contentType,
        score: briefs.score,
        status: briefs.status,
      })
      .from(briefs)
      // `new` only. An `accepted` brief already has a content piece sitting in
      // a later column, so showing it here would double-count the same work;
      // `dismissed` and `expired` are decisions already made. The tenant
      // filter is the security boundary and lives here, in the WHERE clause,
      // not in the loop below.
      .where(and(eq(briefs.tenantId, tenantId), eq(briefs.status, "new")))
      // Same ordering the old /briefs inbox used: scores cluster
      // narrowly, so recency breaks the ties score leaves.
      .orderBy(desc(briefs.score), desc(briefs.createdAt)),
  ]);

  // Seeded with every column so an empty column is `[]` rather than absent —
  // a missing key would render as a missing column, not an empty one.
  const board: Board = {
    [BRIEF_COLUMN]: briefRows.map((row) => ({ kind: "brief", ...row })),
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
    if (opts.assignedTo === "unassigned" && row.assignedTo !== null) continue;
    if (opts.assignedTo && opts.assignedTo !== "unassigned" && row.assignedTo !== opts.assignedTo) continue;
    board[row.status].push({
      kind: "piece",
      ...row,
      status: row.status,
      generationStep: row.generationStep as DraftStepKey | null,
    });
  }

  // Sliced to the limit AFTER ordering (newest first) and AFTER the assignee
  // filter above, so the newest survive and the cap applies to the same set
  // the caller sees, not to a superset it never gets to look at.
  board.published = board.published.slice(0, PUBLISHED_COLUMN_LIMIT);

  return board;
}

// The sidebar's Board badge — briefs waiting on a decision, plus pieces at
// `brief`, `draft` or `review`. Deliberately NOT the board's own total: the
// `total` that used to sit in the /board h1 (deleted when this badge replaced
// it) summed all five columns plus briefs, Scheduled and Published included.
// This number answers a different question — how much is still in flight and
// wants a person — so work that has left active drafting is excluded on
// purpose. It is not a regression of the old count; don't "fix" it back.
//
// Deliberately NOT assignee-filter-aware either: the sidebar renders on
// every page and has no access to /board's `?assignee=` filter, so this
// always counts the whole tenant. That means with a filter active, this
// number and the filtered board columns can disagree — that mismatch is the
// accepted trade (see the "Out of scope" note in the delete-on-the-card
// plan), not a bug to fix by threading the filter into the layout.
export async function readBoardNavCount(tenantId: string, database: Database = defaultDb): Promise<number> {
  const [[pieceRow], [briefRow]] = await Promise.all([
    database
      .select({ value: count() })
      .from(contentPieces)
      .where(
        and(eq(contentPieces.tenantId, tenantId), inArray(contentPieces.status, ["brief", "draft", "review"]))
      ),
    database
      .select({ value: count() })
      .from(briefs)
      .where(and(eq(briefs.tenantId, tenantId), eq(briefs.status, "new"))),
  ]);
  return (pieceRow?.value ?? 0) + (briefRow?.value ?? 0);
}

export type MoveResult = { ok: true } | { ok: false; error: string };

// Explicit allowed-pairs table, not a negation list — a negation list
// silently permits whatever nobody thought to forbid. `draft`, `review`, and
// `scheduled` are the planning states a human owns and can freely move a
// card between; `brief` (the accept-time scaffold, left only by generation)
// and `published` (already shipped, entered only through `approveDraft`'s
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
