"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
// Type-only: `@/lib/content/board` also imports `db`, so importing any
// runtime binding from it here (BOARD_COLUMNS, canMove, ...) would pull
// Postgres into the browser bundle, the same way this project once shipped
// the AI SDK into the browser. `columns`, `moveMatrix`, and `publishedLimit`
// below carry down as plain serializable props instead — computed once on
// the server in page.tsx from the real `canMove`/`BOARD_COLUMNS`.
import type {
  Board as BoardData,
  BoardBriefCard,
  BoardCard as BoardCardType,
  BoardColumn,
  BriefColumn,
  DisplayColumn,
} from "@/lib/content/board";
import type { WorkspaceMember } from "@/lib/workspace/members";
import { Column } from "./column";
import { BoardCardItem } from "./card";
import { boardCollisionDetection } from "./collision";
import { moveCard } from "./actions";

// The server module's BRIEF_COLUMN, which cannot be imported here as a
// runtime value for the reason above. The `BriefColumn` annotation is what
// keeps this copy honest: if that constant's literal ever changes, this line
// stops compiling rather than silently addressing a column that isn't there.
const BRIEF_COLUMN: BriefColumn = "briefs";

const COLUMN_LABEL: Record<DisplayColumn, string> = {
  // Brief holds two populations, which is why there are five labels for six
  // board keys (`Board`'s BoardColumn statuses plus the separate `briefs`
  // key — see `src/lib/content/board.ts`). Rows from the `briefs` table —
  // commissions awaiting a decision — sit here alongside content pieces in
  // the `brief` *status*, the accept-time scaffold a piece occupies for
  // about the length of one generation. Both are "this is not written yet",
  // so they share a column rather than splitting into Brief and Generating;
  // and with no second column there is no drop target, which is why
  // accepting a brief is a button on its card rather than a drag.
  briefs: "Brief",
  draft: "Draft",
  review: "Review",
  scheduled: "Scheduled",
  published: "Published",
};

type BoardState = BoardData;
/** Either kind of card the board renders. Only in the Brief column do both
 * kinds appear; every other column is pieces. */
type AnyCard = BoardCardType | BoardBriefCard;

/** Every display column except Brief is a real `contentPieces.status`. */
const isPieceColumn = (column: DisplayColumn): column is Exclude<DisplayColumn, BriefColumn> =>
  column !== BRIEF_COLUMN;

/**
 * Content pieces only — the brief column is not searched. A brief is not
 * draggable, so no brief id can reach here; and if one somehow did, the
 * right answer is "not found", because everything downstream of this
 * (`activeCard`, `applyMove`, `moveCard`) is the content-piece path and a
 * brief id must never enter it.
 */
function findCard(
  board: BoardState,
  columns: readonly BoardColumn[],
  id: string
): { card: BoardCardType; column: BoardColumn } | null {
  for (const column of columns) {
    const card = board[column].find((c) => c.id === id);
    if (card) return { card, column };
  }
  return null;
}

/**
 * The board's client half: owns the drag interaction (dnd-kit), the
 * scheduling picker, and enough local state to make a drop feel instant.
 * `initialBoard`/`members` are plain data passed down from the Server
 * Component page — never a `db` import or any other server-only value, per
 * the rule that broke this project once already with the AI SDK.
 */
export function Board({
  initialBoard,
  members,
  assigneeFilter,
  columns,
  displayColumns,
  moveMatrix,
  publishedLimit,
}: {
  initialBoard: BoardState;
  members: WorkspaceMember[];
  assigneeFilter: string;
  /** BOARD_COLUMNS, handed down rather than imported — see the note above.
   * The five content-piece statuses, which is what the move rules and the
   * assignee patching below operate on. */
  columns: readonly BoardColumn[];
  /** BOARD_DISPLAY_COLUMNS: the render order, Brief first. Kept separate
   * from `columns` because Brief is not a `contentPieces.status` and must
   * never be handed to anything that treats a column as one — and because
   * the `brief` status has no column of its own, so this is one shorter. */
  displayColumns: readonly DisplayColumn[];
  /** `moveMatrix[from]` is every `to` the real `canMove` permits from `from`,
   * precomputed server-side so the client never needs its own copy of the
   * allowed-pairs table (and can never drift from it). */
  moveMatrix: Record<BoardColumn, BoardColumn[]>;
  publishedLimit: number;
}) {
  const router = useRouter();
  const [board, setBoard] = useState(initialBoard);
  const canMove = (from: BoardColumn, to: BoardColumn) => moveMatrix[from]?.includes(to) ?? false;

  /**
   * The one predicate deciding whether a drop is offered at all. It is
   * passed to each Column as `droppable`, which becomes `disabled` in
   * `useDroppable`, removing that column from the set of droppables
   * dnd-kit will even consider.
   *
   * That is necessary but NOT sufficient, and believing otherwise was a
   * Critical: `disabled` controls *candidacy*, not *hit-testing*. With a
   * ranking strategy like `closestCenter`, the last remaining enabled
   * column wins every release no matter where the pointer is. The
   * collision strategy (./collision) is what makes a release outside every
   * enabled column resolve to nothing; `handleDragEnd` checks `canDrop`
   * once more on top.
   */
  function canDrop(card: BoardCardType | null, to: DisplayColumn): boolean {
    if (!card) return false;
    // Nothing may be dropped INTO Brief. A content piece cannot become a
    // brief — the relationship is one-way — and the briefs already there
    // are not draggable, so no card of either kind has business landing
    // in this column.
    if (!isPieceColumn(to)) return false;
    return canMove(card.status, to);
  }

  // The server is the source of truth. Every successful mutation triggers
  // router.refresh(), which re-runs the page's readBoard() and hands back a
  // new `initialBoard` object — resync local state to it here, during render
  // (React's documented pattern for "adjusting state when a prop changes"),
  // rather than trusting the optimistic patch forever or doing this
  // setState-on-prop-change dance inside a useEffect.
  const [syncedBoard, setSyncedBoard] = useState(initialBoard);
  if (initialBoard !== syncedBoard) {
    setSyncedBoard(initialBoard);
    setBoard(initialBoard);
  }

  // A piece or nothing: briefs are not draggable (acceptance is a button on
  // the card), so a brief can never be the card being dragged.
  const [activeCard, setActiveCard] = useState<BoardCardType | null>(null);
  // A drop onto "scheduled" doesn't move the card immediately — it opens
  // this picker, and the move only happens on confirm. Cancelling (or
  // navigating away) leaves the card exactly where it was, so an
  // unconfirmed drop is a no-op, not a move.
  const [pendingSchedule, setPendingSchedule] = useState<{ id: string } | null>(null);
  const [scheduleValue, setScheduleValue] = useState("");
  const [scheduling, setScheduling] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  function handleDragStart(event: DragStartEvent) {
    const found = findCard(board, columns, String(event.active.id));
    setActiveCard(found?.card ?? null);
  }

  function handleDragCancel() {
    setActiveCard(null);
  }

  async function applyMove(id: string, to: BoardColumn, scheduledForIso?: string) {
    const found = findCard(board, columns, id);
    if (!found) return;
    const { card: original, column: from } = found;

    // Optimistic: the card jumps to its new column right away. A refused
    // move (result.ok === false) reverts it and surfaces result.error via
    // toast — a refused move must not look like it succeeded.
    const moved: BoardCardType = {
      ...original,
      status: to,
      scheduledFor: to === "scheduled" && scheduledForIso ? new Date(scheduledForIso) : null,
    };
    setBoard((prev) => ({
      ...prev,
      [from]: prev[from].filter((c) => c.id !== id),
      [to]: [moved, ...prev[to]],
    }));

    const revert = () =>
      setBoard((prev) => ({
        ...prev,
        [to]: prev[to].filter((c) => c.id !== id),
        [from]: [original, ...prev[from]],
      }));

    // A thrown rejection (expired session, a DB blip, any server error) is
    // just as much a failed move as an explicit `{ ok: false }` — without
    // this catch, an uncaught rejection here leaves the optimistic patch in
    // place forever with no toast, so the card sits in a column the server
    // never actually wrote it into.
    try {
      const result = await moveCard(id, to, scheduledForIso);
      if (!result.ok) {
        toast.error(result.error);
        revert();
        return;
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong. The move wasn't saved.");
      revert();
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const card = activeCard;
    setActiveCard(null);
    if (!card) return;
    const over = event.over;
    if (!over) return;
    const to = String(over.id) as DisplayColumn;
    // Belt and suspenders: a column canDrop forbids is `disabled` in
    // useDroppable and so is never a collision candidate. Checked again
    // here anyway — the droppable set is what dnd-kit *considers*, and
    // which of those candidates becomes `over` is the collision strategy's
    // call, not a guarantee this handler should take on trust.
    if (!canDrop(card, to)) return;

    // Unreachable — canDrop above already refused every non-piece column.
    // Kept so `to` narrows to a status the move path can actually write.
    if (!isPieceColumn(to)) return;
    const from = card.status;
    if (from === to) return;

    if (to === "scheduled") {
      setPendingSchedule({ id: card.id });
      setScheduleValue("");
      return;
    }

    void applyMove(card.id, to);
  }

  function confirmSchedule() {
    if (!pendingSchedule || !scheduleValue) return;
    // `datetime-local` yields local wall-clock time with no offset; `new
    // Date(...)` on that exact string form parses it as local time (per the
    // spec for date-time strings without a timezone), so this is the
    // instant the picker actually shows, converted for the wire as ISO.
    const date = new Date(scheduleValue);
    if (Number.isNaN(date.getTime())) {
      toast.error("Enter a valid date and time.");
      return;
    }
    setScheduling(true);
    void applyMove(pendingSchedule.id, "scheduled", date.toISOString()).finally(() => {
      setScheduling(false);
      setPendingSchedule(null);
    });
  }

  function handleAssigned(id: string, userId: string | null) {
    setBoard((prev) => {
      const next = { ...prev };
      for (const column of columns) {
        next[column] = next[column].map((c) => (c.id === id ? { ...c, assignedTo: userId } : c));
      }
      return next;
    });
  }

  function pushAssigneeFilter(value: string | null) {
    const qs = !value || value === "all" ? "" : `?assignee=${value}`;
    router.push(`/board${qs}`);
  }

  const assigneeOptions = [
    { value: "all", label: "Everyone" },
    { value: "unassigned", label: "Unassigned" },
    ...members.map((m) => ({ value: m.userId, label: m.name ?? m.email })),
  ];

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-center gap-2">
        <Label htmlFor="board-assignee-filter" className="text-sm text-muted-foreground">
          Assigned to
        </Label>
        <Select value={assigneeFilter} onValueChange={pushAssigneeFilter}>
          <SelectTrigger id="board-assignee-filter" className="w-44">
            <SelectValue>{assigneeOptions.find((o) => o.value === assigneeFilter)?.label ?? "Everyone"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {assigneeOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DndContext
        sensors={sensors}
        // Not closestCenter: it ranks every *enabled* droppable and always
        // returns one, so a release anywhere on the board resolves to a
        // column the pointer was never over — a `draft` released over
        // Published landed in whichever of Review and Scheduled was nearer.
        // See ./collision.
        collisionDetection={boardCollisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="flex flex-1 items-start gap-4 overflow-x-auto pb-4">
          {displayColumns.map((column) => {
            // `assignedTo` is a content-piece concept: a brief has no
            // assignee, and readBoard deliberately does not filter briefs by
            // one. Showing every brief anyway would be a column quietly
            // ignoring an active filter, and dropping the column would be one
            // that vanishes — so the briefs go and the column says why.
            //
            // Only the briefs. The pieces sharing this column DO have an
            // assignee and were already filtered server-side, so they stay:
            // one column, two populations, two filter semantics, and the
            // note below is what stops that from reading as a bug.
            //
            // `board.briefs.length > 0` matters: without it, a filter active
            // over zero `new` briefs still claims briefs are being withheld,
            // right under a "No cards." that already says nothing is here —
            // a visible contradiction, not just an inaccuracy nobody sees.
            const filterHidesBriefs =
              column === BRIEF_COLUMN && assigneeFilter !== "all" && board.briefs.length > 0;
            // Pieces first, then briefs. A piece is work already commissioned
            // and in motion; a brief is still a proposal. Ordering it this way
            // makes accepting a brief read as a promotion to the top of the
            // same column, and keeps the cards whose state changes while you
            // watch them off the bottom of an unbounded, score-ordered list.
            const visible: AnyCard[] =
              column === BRIEF_COLUMN
                ? [...board.brief, ...(filterHidesBriefs ? [] : board[BRIEF_COLUMN])]
                : board[column];
            return (
              <Column
                key={column}
                id={column}
                title={COLUMN_LABEL[column]}
                count={visible.length}
                droppable={canDrop(activeCard, column)}
              >
                {column === "published" && (
                  <Link
                    href="/history"
                    className="flex items-center gap-1 px-1 pb-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    Full history
                    <ArrowRight className="size-3" />
                  </Link>
                )}

                {/* The hand-written-from-scratch path recovered from the
                    deleted /briefs list page (see `NewBriefAction` in that
                    page's history) — `/briefs/new` with no `?signals=` is its
                    own zero-signal branch, and without a link somewhere the
                    only route to it was the selection bar's failure branch on
                    /signals. Lives on the Brief column specifically, not the
                    board header, because it's an action on this column's
                    contents, not the whole board. */}
                {column === BRIEF_COLUMN && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    render={<Link href="/briefs/new" />}
                  >
                    New brief
                  </Button>
                )}


                {visible.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">No cards.</p>
                ) : (
                  visible.map((card) => (
                    <BoardCardItem
                      key={card.id}
                      card={card}
                      members={members}
                      // Per card, not per column, now that one column holds
                      // both kinds. A brief does not drag (Accept is its only
                      // exit), nor does a piece mid-generation (Generate is
                      // its only exit) or a published one (terminal).
                      draggable={
                        card.kind === "piece" && card.status !== "brief" && card.status !== "published"
                      }
                      onGenerated={() => router.refresh()}
                      onAccepted={() => router.refresh()}
                      onAssigned={(userId) => handleAssigned(card.id, userId)}
                    />
                  ))
                )}

                {/* Below the cards, not instead of them: the pieces above are
                    a real answer to the filter, and this note is only about
                    the briefs it could not be applied to. When nothing is
                    visible at all, "No cards." above says the pieces found
                    nothing and this says the briefs were never asked — two
                    empties, two reasons, both worth stating. */}
                {filterHidesBriefs && (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    Briefs aren&rsquo;t assigned to anyone, so none are shown while the board is
                    filtered by assignee; the pieces generating here still follow it. Choose
                    &ldquo;Everyone&rdquo; to see the briefs.
                  </p>
                )}

                {column === "published" && visible.length >= publishedLimit && (
                  <p className="px-1 pt-1 text-xs text-muted-foreground">
                    Showing the most recent {publishedLimit}. See the full history for the rest.
                  </p>
                )}
              </Column>
            );
          })}
        </div>
      </DndContext>

      <Dialog open={pendingSchedule !== null} onOpenChange={(open) => !open && setPendingSchedule(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Schedule this piece</DialogTitle>
            <DialogDescription>
              Pick a date and time. Scheduling does not publish — nothing goes out on its own at that
              time; publishing is still a separate, human step.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="scheduled-for">Date and time</Label>
            <Input
              id="scheduled-for"
              type="datetime-local"
              value={scheduleValue}
              onChange={(e) => setScheduleValue(e.target.value)}
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={scheduling} />}>
              Cancel
            </DialogClose>
            <Button type="button" onClick={confirmSchedule} disabled={!scheduleValue || scheduling}>
              {scheduling ? "Scheduling…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
