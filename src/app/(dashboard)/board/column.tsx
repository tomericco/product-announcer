"use client";

import type { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * One column of the board. `droppable` reflects whether the card currently
 * being dragged (if any) is allowed into this column — computed by the
 * caller from `canMove(activeCard.status, id)`, so the same rule the server
 * enforces in `moveContentPiece` also decides what the UI offers as a drop
 * target. `useDroppable`'s own `disabled` flag (not just styling) backs
 * this: a disabled droppable never becomes `over`, so a card dragged over a
 * column the mesh does not permit simply does not register a drop there.
 */
export function Column({
  id,
  title,
  count,
  droppable,
  children,
}: {
  id: string;
  title: string;
  count: number;
  droppable: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable });

  return (
    <div className="flex w-72 shrink-0 flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Badge variant="secondary">{count}</Badge>
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
