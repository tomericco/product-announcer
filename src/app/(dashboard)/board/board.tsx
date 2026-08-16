"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Plus } from "lucide-react";
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
import { GenerationModal } from "@/components/generation-modal";
import { Column } from "./column";
import { BoardCardItem } from "./card";
import { boardCollisionDetection } from "./collision";
import { moveCard, acceptBriefCard } from "./actions";

// The server module's BRIEF_COLUMN, which cannot be imported here as a
// runtime value for the reason above. The `BriefColumn` annotation is what
// keeps this copy honest: if that constant's literal ever changes, this line
// stops compiling rather than silently addressing a column that isn't there.
const BRIEF_COLUMN: BriefColumn = "briefs";

const COLUMN_LABEL: Record<DisplayColumn, string> = {
  // Five labels for six board keys (`Board`'s BoardColumn statuses plus the
  // separate `briefs` key — see `src/lib/content/board.ts`): Draft is the
  // one column with two populations. Rows from the `briefs` table —
  // commissions awaiting a decision — get their own column; content pieces
  // in the `brief` *status* — the accept-time scaffold a piece occupies for
  // about the length of one generation — render in Draft instead, alongside
  // finished drafts, because accepting a brief IS a drag onto Draft: a piece
  // that stayed in Brief until generation finished would make that drag look
  // like it hadn't stuck. Brief itself is not a drop target for anything —
  // briefs leave this column, nothing arrives in it.
  briefs: "Brief",
  draft: "Draft",
  review: "Review",
  scheduled: "Scheduled",
  published: "Published",
};

type BoardState = BoardData;
/** Either kind of card the board renders. No column mixes kinds: Brief holds
 * only briefs, Draft holds only pieces (both the ones mid-generation and the
 * finished drafts), and so does every column after it. */
type AnyCard = BoardCardType | BoardBriefCard;

/** Every display column except Brief is a real `contentPieces.status`. */
const isPieceColumn = (column: DisplayColumn): column is Exclude<DisplayColumn, BriefColumn> =>
  column !== BRIEF_COLUMN;

/**
 * Content pieces only — the brief column is deliberately not searched, even
 * though briefs drag now. Everything downstream of this (`applyMove`,
 * `moveCard`, `moveContentPiece`) is the content-piece path, and a brief id
 * must never enter it: acceptance is a different transition with a different
 * authority (`acceptBriefCard`). "Not found" is the right answer for a brief
 * id here, which is why `findDragged` below looks briefs up separately
 * rather than widening this.
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
 * The card a drag just picked up, of either kind. Briefs first: they are the
 * smaller list, and the two id spaces are disjoint (`briefs.id` vs
 * `contentPieces.id`), so order is about cost, not correctness.
 */
function findDragged(board: BoardState, columns: readonly BoardColumn[], id: string): AnyCard | null {
  const brief = board[BRIEF_COLUMN].find((b) => b.id === id);
  if (brief) return brief;
  return findCard(board, columns, id)?.card ?? null;
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
  function canDrop(card: AnyCard | null, to: DisplayColumn): boolean {
    if (!card) return false;
    // Nothing may be dropped INTO Brief. A content piece cannot become a
    // brief — the relationship is one-way — and a brief dropped back where
    // it started is not a transition, so no card of either kind has
    // business landing in this column.
    if (!isPieceColumn(to)) return false;
    // A brief has exactly one destination, and it is not a `canMove`
    // question: it has no `contentPieces.status` to move FROM, and
    // acceptance is a different transition with a different authority
    // (`acceptBriefCard` → `acceptBrief`) from the piece moves the matrix
    // governs. Draft is where it goes because that is where the piece
    // acceptance creates renders while it generates.
    if (card.kind === "brief") return to === "draft";
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

  // Either kind, or nothing. A brief drags now — that is how it is accepted
  // — so `canDrop` and `handleDragEnd` both have to branch on `kind` rather
  // than assume a piece.
  const [activeCard, setActiveCard] = useState<AnyCard | null>(null);
  // A drop onto "scheduled" doesn't move the card immediately — it opens
  // this picker, and the move only happens on confirm. Cancelling (or
  // navigating away) leaves the card exactly where it was, so an
  // unconfirmed drop is a no-op, not a move.
  const [pendingSchedule, setPendingSchedule] = useState<{ id: string } | null>(null);
  const [scheduleValue, setScheduleValue] = useState("");
  const [scheduling, setScheduling] = useState(false);
  // The piece a just-accepted brief is generating into, watched in the modal
  // at the bottom of this component. It lives HERE rather than on the brief
  // card that started it because accepting removes that card: the refresh
  // below swaps the brief for the piece, and a modal mounted inside the card
  // would be torn down by the very refetch that proves the accept worked.
  const [generatingPieceId, setGeneratingPieceId] = useState<string | null>(null);
  // A brief released over Draft, awaiting confirmation. Like `pendingSchedule`
  // above, the drop itself is not the mutation: it opens a dialog, and
  // cancelling leaves the brief exactly where it was.
  //
  // Why a confirmation at all, behind a gesture as deliberate as a drag: it
  // was added at the owner's explicit request when Accept was a one-click
  // button, and acceptance is still irreversible — a content piece created,
  // the brief flipped to `accepted` with no un-accept path, and a model call
  // spent. Whether the drag makes it redundant is the owner's call to make,
  // not this component's; until then it stays wired to the drop.
  //
  // It lives HERE and not on the brief card for the same reason the
  // generation modal does: accepting removes that card, so a dialog mounted
  // inside it would be unmounted by the refetch that proves the accept
  // worked. The title rides along so the dialog can name the brief after the
  // card is gone.
  const [pendingAccept, setPendingAccept] = useState<{ id: string; title: string } | null>(null);
  const [accepting, startAccept] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveCard(findDragged(board, columns, String(event.active.id)));
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

    // A brief takes the acceptance path, never the move path: no optimistic
    // patch (the piece it becomes does not exist client-side yet, so there
    // is nothing honest to render), and no `moveCard`. canDrop above has
    // already established `to` is Draft.
    if (card.kind === "brief") {
      setPendingAccept({ id: card.id, title: card.title });
      return;
    }

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

  /**
   * The confirmed drop. Same request-report-refetch shape as the piece
   * card's Generate button: report a refusal, then let the board re-read the
   * server rather than guessing at the result.
   */
  function confirmAccept() {
    if (!pendingAccept) return;
    const briefId = pendingAccept.id;
    startAccept(async () => {
      // Unlike `moveCard`, acceptance is not repeatable (the brief flips to
      // `accepted` and a generation fires), so a thrown rejection — an
      // expired session, a DB blip — must not leave the drop silent and the
      // user dropping again.
      try {
        const result = await acceptBriefCard(briefId);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success("Brief accepted. Generating the draft…");
        setPendingAccept(null);
        // Both, and in this order: the modal is what the person who just
        // dropped the card watches, and the refetch is what swaps the brief
        // for the piece acceptance created — with its own inline checklist —
        // behind it, so closing the modal leaves a card still reporting the
        // run.
        setGeneratingPieceId(result.contentPieceId);
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Something went wrong. The brief wasn't accepted."
        );
      }
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
            // that vanishes — so when a filter is active, every brief is
            // withheld and the column says why. Brief holds only briefs now
            // (see COLUMN_LABEL above), so this is the whole story for this
            // column — no second, differently-filtered population to reason
            // about beside it any more.
            //
            // `board.briefs.length > 0` matters: without it, a filter active
            // over zero `new` briefs still claims briefs are being withheld,
            // right under a "No cards." that already says nothing is here —
            // a visible contradiction, not just an inaccuracy nobody sees.
            const filterHidesBriefs =
              column === BRIEF_COLUMN && assigneeFilter !== "all" && board.briefs.length > 0;
            // Draft is the one column with two populations: pieces mid-
            // generation (`status = "brief"`) and finished drafts. Generating
            // pieces sit ABOVE finished drafts — they are work in flight
            // whose visible state (checklist step, Retry) changes while you
            // watch, the same reason briefs-on-the-board originally put them
            // above the (unbounded, score-ordered) brief list they used to
            // share a column with; and in practice they are also the newest
            // thing here, since generation starts the moment a brief is
            // accepted. Pinning them to the top keeps the card someone is
            // actively watching from drifting under a growing list of
            // already-settled drafts. Pieces have their own assignee and are
            // already filtered server-side (readBoard), so — unlike briefs —
            // nothing here needs to hide them again for the filter.
            const visible: AnyCard[] =
              column === BRIEF_COLUMN
                ? filterHidesBriefs
                  ? []
                  : board[BRIEF_COLUMN]
                : column === "draft"
                  ? [...board.brief, ...board.draft]
                  : board[column];
            return (
              <Column
                key={column}
                id={column}
                title={COLUMN_LABEL[column]}
                count={visible.length}
                droppable={canDrop(activeCard, column)}
                // The hand-written-from-scratch path recovered from the
                // deleted /briefs list page (see `NewBriefAction` in that
                // page's history) — `/briefs/new` with no `?signals=` is its
                // own zero-signal branch, and without a link somewhere the
                // only route to it was the selection bar's failure branch on
                // /signals. Lives on the Brief column specifically, not every
                // column, because it's an action on this column's contents,
                // not the whole board — passed only here, never inside
                // `Column` itself. `aria-label` carries the accessible name:
                // a bare `+` icon has none on its own, and this is the only
                // route in the app to writing a brief from scratch.
                headerAction={
                  column === BRIEF_COLUMN ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="New brief"
                      render={<Link href="/briefs/new" />}
                    >
                      <Plus className="size-4" />
                    </Button>
                  ) : undefined
                }
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

                {visible.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">No cards.</p>
                ) : (
                  visible.map((card) => (
                    <BoardCardItem
                      key={card.id}
                      card={card}
                      members={members}
                      // Per card, not per column: the two kinds are
                      // drag-eligible under different rules. A brief always
                      // drags — onto Draft, which is how it is accepted. A
                      // piece does not while mid-generation (Generate is its
                      // only exit) or once published (terminal).
                      draggable={
                        card.kind === "brief" ||
                        (card.status !== "brief" && card.status !== "published")
                      }
                      onGenerated={() => router.refresh()}
                      onAssigned={(userId) => handleAssigned(card.id, userId)}
                    />
                  ))
                )}

                {/* Brief holds only briefs, so when this fires the column is
                    empty of everything and "No cards." (above, from
                    `visible.length === 0`) already says so; this note adds
                    the reason — that the filter withheld the briefs
                    entirely, rather than there being none to show. */}
                {filterHidesBriefs && (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    Briefs aren&rsquo;t assigned to anyone, so none are shown while the board is
                    filtered by assignee. Choose &ldquo;Everyone&rdquo; to see them.
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

      {/* Closing is not a cancel — the run continues in `after()` and the
          card behind this keeps reporting it. The re-read on close is what
          picks up a run that landed while the modal was open (the checklist
          inside it deliberately does not refresh; see `refreshOnTerminal`). */}
      <GenerationModal
        contentPieceId={generatingPieceId}
        onClose={() => {
          setGeneratingPieceId(null);
          router.refresh();
        }}
      />

      {/* The dropped brief's confirmation. Reuses the repo's confirm-dialog
          shape (`draft-row-menu.tsx`'s "Publish this update?" / "Delete this
          draft?", and the "Schedule this piece" step below) — see
          `pendingAccept` for why it survives the move from button to drag. */}
      <Dialog
        open={pendingAccept !== null}
        onOpenChange={(next) => !next && !accepting && setPendingAccept(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Generate a draft from &ldquo;{pendingAccept?.title}&rdquo;?</DialogTitle>
            <DialogDescription>This creates a draft and can&apos;t be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" disabled={accepting} />}>
              Cancel
            </DialogClose>
            <Button type="button" onClick={confirmAccept} disabled={accepting}>
              {accepting ? "Generating…" : "Generate draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
