import { Badge } from "@/components/ui/badge";
import { requireSession } from "@/lib/workspace/session";
import {
  readBoard,
  canMove,
  BOARD_COLUMNS,
  PUBLISHED_COLUMN_LIMIT,
  type BoardCard,
  type BoardColumn,
} from "@/lib/content/board";
import { listWorkspaceMembers } from "@/lib/workspace/members";
import { Board } from "./board";

/**
 * `/board`: brief → draft → review → scheduled → published, alongside
 * (not replacing) /briefs and /drafts.
 *
 * `searchParams` is a Promise in this Next.js version — see the "Rendering
 * with search params" note in
 * node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md
 * — and reading it (for the assignee filter, ?assignee=<userId|unassigned>)
 * opts the page into dynamic rendering, mirroring /signals.
 *
 * The filter is applied here, after readBoard() returns every column for
 * the tenant — readBoard's signature is fixed by Task 1/2 and takes no
 * filter argument, so narrowing by assignee is this page's job, not the
 * board module's.
 */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const rawAssignee = params.assignee;
  const assigneeParam = Array.isArray(rawAssignee) ? rawAssignee[0] : rawAssignee;
  const assigneeFilter = assigneeParam ?? "all";

  const session = await requireSession();
  const [board, members] = await Promise.all([
    readBoard(session.user.tenantId),
    listWorkspaceMembers(session.user.tenantId),
  ]);

  const filteredBoard =
    assigneeFilter === "all"
      ? board
      : (Object.fromEntries(
          BOARD_COLUMNS.map((column) => [
            column,
            board[column].filter((card) =>
              assigneeFilter === "unassigned" ? card.assignedTo === null : card.assignedTo === assigneeFilter
            ),
          ])
        ) as Record<BoardColumn, BoardCard[]>);

  const total = BOARD_COLUMNS.reduce((sum, column) => sum + filteredBoard[column].length, 0);

  // Computed here (server-side, from the real `canMove`) and handed down as
  // plain data — `board.tsx` is a Client Component and must not import
  // `canMove` itself: `@/lib/content/board` also imports `db`, and importing
  // any runtime binding from it into client code would pull Postgres into
  // the browser bundle. See the comment in board.tsx for the fuller version
  // of this note.
  const moveMatrix = Object.fromEntries(
    BOARD_COLUMNS.map((from) => [from, BOARD_COLUMNS.filter((to) => canMove(from, to))])
  ) as Record<BoardColumn, BoardColumn[]>;

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-center gap-2">
        <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Board</h1>
        <Badge variant="secondary">{total}</Badge>
      </div>
      <Board
        initialBoard={filteredBoard}
        members={members}
        assigneeFilter={assigneeFilter}
        columns={BOARD_COLUMNS}
        moveMatrix={moveMatrix}
        publishedLimit={PUBLISHED_COLUMN_LIMIT}
      />
    </div>
  );
}
