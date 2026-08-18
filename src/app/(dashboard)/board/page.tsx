import { requireSession } from "@/lib/workspace/session";
import {
  readBoard,
  canMove,
  BOARD_COLUMNS,
  BOARD_DISPLAY_COLUMNS,
  PUBLISHED_COLUMN_LIMIT,
  type BoardColumn,
} from "@/lib/content/board";
import { listWorkspaceMembers } from "@/lib/workspace/members";
import { Board } from "./board";

/**
 * `/board`: Brief → Draft → Review → Scheduled → Published, alongside (not
 * replacing) /drafts. The first column holds two things: real
 * briefs (a different table) and the pieces generating from accepted ones,
 * which is why BOARD_DISPLAY_COLUMNS is one shorter than BOARD_COLUMNS. The
 * rest are one `contentPieces.status` each.
 *
 * `searchParams` is a Promise in this Next.js version — see the "Rendering
 * with search params" note in
 * node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md
 * — and reading it (for the assignee filter, ?assignee=<userId|unassigned>)
 * opts the page into dynamic rendering, mirroring /signals.
 *
 * The filter is passed INTO readBoard, not applied here afterwards —
 * readBoard applies it before slicing the published column to
 * PUBLISHED_COLUMN_LIMIT. Filtering after that slice would show only a
 * filtered share of the 20 newest published pieces overall while the count
 * still read as a total for the filtered set.
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
  const [filteredBoard, members] = await Promise.all([
    readBoard(
      session.user.tenantId,
      undefined,
      assigneeFilter === "all" ? {} : { assignedTo: assigneeFilter }
    ),
    listWorkspaceMembers(session.user.tenantId),
  ]);

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
      <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Board</h1>
      <Board
        initialBoard={filteredBoard}
        members={members}
        assigneeFilter={assigneeFilter}
        columns={BOARD_COLUMNS}
        displayColumns={BOARD_DISPLAY_COLUMNS}
        moveMatrix={moveMatrix}
        publishedLimit={PUBLISHED_COLUMN_LIMIT}
      />
    </div>
  );
}
