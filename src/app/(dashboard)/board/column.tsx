"use client";

import type { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * One column of the board. `droppable` reflects whether the card currently
 * being dragged (if any) is allowed into this column — computed by the
 * caller from `canDrop(activeCard, id)`, which branches on the dragged
 * card's kind: a piece defers to `canMove(activeCard.status, id)`, the same
 * rule the server enforces in `moveContentPiece`, while a brief (which has
 * no `.status`) is only ever allowed into Draft. `useDroppable`'s own
 * `disabled` flag (not just styling) backs
 * this: a disabled droppable is not a candidate for collision at all, so a
 * card dragged over a column the mesh does not permit cannot land there.
 *
 * Note what that does NOT say: it does not say the pointer must be over
 * this column for it to become `over`. dnd-kit picks the first collision
 * its strategy returns from among the *enabled* droppables, wherever they
 * are — see board/collision.ts, which is the half of this that makes a
 * release over a refused column resolve to nothing.
 */
export function Column({
  id,
  title,
  count,
  droppable,
  headerAction,
  children,
}: {
  id: string;
  title: string;
  count: number;
  droppable: boolean;
  /** An optional trailing control in the header, beside the title and count
   * — e.g. the Brief column's "New brief" link. Nothing here special-cases
   * which column gets one: that decision belongs to the caller (`board.tsx`),
   * not to `Column` itself. */
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable });

  return (
    // Elastic rather than a fixed w-72: the columns share whatever width the
    // page has, so all five fit without horizontal scrolling and simply get
    // roomier on a wide display. min-w-48 is the floor at which a card's
    // title, meta row and buttons still read; below that (a narrow window)
    // the track's overflow-x-auto takes over again.
    <div className="flex min-w-48 flex-1 basis-0 flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Badge variant="secondary">{count}</Badge>
        {headerAction && <div className="ml-auto">{headerAction}</div>}
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-2 rounded-xl border border-dashed border-transparent p-2 transition-colors",
          isOver && droppable && "border-brand-ink bg-brand-subtle/40"
        )}
      >
        {children}
      </div>
    </div>
  );
}
