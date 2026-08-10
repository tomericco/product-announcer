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
  closestCenter,
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
import type { BoardCard as BoardCardType, BoardColumn } from "@/lib/content/board";
import type { WorkspaceMember } from "@/lib/workspace/members";
import { Column } from "./column";
import { BoardCardItem } from "./card";
import { moveCard } from "./actions";

const COLUMN_LABEL: Record<BoardColumn, string> = {
  brief: "Brief",
  draft: "Draft",
  review: "Review",
  scheduled: "Scheduled",
  published: "Published",
};

type BoardState = Record<BoardColumn, BoardCardType[]>;

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
  moveMatrix,
  publishedLimit,
}: {
  initialBoard: BoardState;
  members: WorkspaceMember[];
  assigneeFilter: string;
  /** BOARD_COLUMNS, handed down rather than imported — see the note above. */
  columns: readonly BoardColumn[];
  /** `moveMatrix[from]` is every `to` the real `canMove` permits from `from`,
   * precomputed server-side so the client never needs its own copy of the
   * allowed-pairs table (and can never drift from it). */
  moveMatrix: Record<BoardColumn, BoardColumn[]>;
  publishedLimit: number;
}) {
  const router = useRouter();
  const [board, setBoard] = useState(initialBoard);
  const canMove = (from: BoardColumn, to: BoardColumn) => moveMatrix[from]?.includes(to) ?? false;

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
    const to = String(over.id) as BoardColumn;
    const from = card.status;
    if (from === to) return;
    // Belt and suspenders: the column this landed on should already be
    // `disabled` in useDroppable when canMove forbids it, so `over` should
    // never resolve to it. Checked again here anyway, since the visible
    // column set is a UI convenience, not the actual guarantee.
    if (!canMove(from, to)) return;

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
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="flex flex-1 items-start gap-4 overflow-x-auto pb-4">
          {columns.map((column) => (
            <Column
              key={column}
              id={column}
              title={COLUMN_LABEL[column]}
              count={board[column].length}
              droppable={activeCard ? canMove(activeCard.status, column) : false}
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

              {board[column].length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">No cards.</p>
              ) : (
                board[column].map((card) => (
                  <BoardCardItem
                    key={card.id}
                    card={card}
                    members={members}
                    draggable={column !== "brief" && column !== "published"}
                    onGenerated={() => router.refresh()}
                    onAssigned={(userId) => handleAssigned(card.id, userId)}
                  />
                ))
              )}

              {column === "published" && board[column].length >= publishedLimit && (
                <p className="px-1 pt-1 text-xs text-muted-foreground">
                  Showing the most recent {publishedLimit}. See the full history for the rest.
                </p>
              )}
            </Column>
          ))}
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
