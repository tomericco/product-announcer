"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { GripVertical } from "lucide-react";
import { toast } from "sonner";
import { useDraggable } from "@dnd-kit/core";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { BoardCard as BoardCardType } from "@/lib/content/board";
import type { WorkspaceMember } from "@/lib/workspace/members";
// `generateDraft` is a "use server" export — importing it here wires the
// button straight to the server action, the same pattern
// drafts/[releaseId]/generate-draft-button.tsx already uses. No runtime
// value from a server *module* crosses the boundary; this is a Server
// Function reference, which is how Next.js expects client code to invoke one.
import { generateDraft } from "../briefs/actions";
import { assignCard } from "./actions";

const CONTENT_TYPE_LABEL: Record<BoardCardType["type"], string> = {
  product_update: "Product update",
  blog_post: "Blog post",
  social_post: "Social post",
};

type Props = {
  card: BoardCardType;
  members: WorkspaceMember[];
  /** False for `brief` (no drag out — Generate is the only exit) and
   * `published` (terminal, read-only) cards. */
  draggable: boolean;
  /** Called after a successful generation so the board can pick up the
   * piece's new status and body — `generateDraft` only revalidates /drafts
   * and /drafts/[id], not /board. */
  onGenerated: () => void;
  onAssigned: (userId: string | null) => void;
};

/**
 * One card on the board. The drag handle is a small grip icon, not the
 * whole card — the title links to `/drafts/[id]` and the assignee picker is
 * an interactive `<Select>`, and attaching dnd-kit's pointer listeners to
 * the entire card would fight both of those for the initial pointerdown.
 */
export function BoardCardItem({ card, members, draggable, onGenerated, onAssigned }: Props) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
    disabled: !draggable,
  });

  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        position: "relative" as const,
        zIndex: 20,
      }
    : undefined;

  const [generating, startGenerate] = useTransition();
  const [assigning, setAssigning] = useState(false);

  function handleGenerate() {
    startGenerate(async () => {
      const result = await generateDraft(card.id);
      // Refresh either way: a failure still writes `generationError` to the
      // row (status stays "brief"), and the card must pick that up — not
      // just flash a toast that then leaves the card looking untouched.
      onGenerated();
      if (!result.ok) toast.error(result.error);
    });
  }

  async function handleAssign(value: string) {
    const userId = value === "unassigned" ? null : value;
    if (userId === card.assignedTo) return;
    setAssigning(true);
    try {
      const result = await assignCard(card.id, userId);
      if (result.ok) {
        onAssigned(userId);
      } else {
        // Do not swallow a refused assignment — the select must not read as
        // if it succeeded.
        toast.error(result.error);
      }
    } finally {
      setAssigning(false);
    }
  }

  const assignedMember = card.assignedTo ? members.find((m) => m.userId === card.assignedTo) : undefined;

  return (
    <div ref={setNodeRef} style={style} className={cn(isDragging && "opacity-40")}>
      <Card size="sm">
        <CardContent className="space-y-2">
          <div className="flex items-start gap-1.5">
            {draggable && (
              <button
                type="button"
                className="mt-0.5 shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
                aria-label={`Move ${card.title}`}
                {...attributes}
                {...listeners}
              >
                <GripVertical className="size-4" />
              </button>
            )}
            <Link
              href={`/drafts/${card.id}`}
              className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
            >
              {card.title}
            </Link>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{CONTENT_TYPE_LABEL[card.type]}</Badge>

            {/* A "brief" card with generationError is a failed generation —
                the scaffold body is intact and Generate below offers a retry. */}
            {card.status === "brief" && (
              <Badge variant={card.generationError ? "destructive" : "outline"}>
                {card.generationError ? "Generation failed" : "Awaiting generation"}
              </Badge>
            )}

            {/* A "draft" card with generationError is a WARNING, not a
                failure: the post-generation name scan matched something. The
                draft itself generated fine. */}
            {card.status === "draft" && card.generationError && (
              <Badge variant="outline" title={card.generationError}>
                Flagged copy
              </Badge>
            )}

            {card.status === "scheduled" && card.scheduledFor && (
              <Badge variant="outline">{format(card.scheduledFor, "d MMM, HH:mm")}</Badge>
            )}
          </div>

          {card.status === "brief" && card.generationError && (
            <p className="text-xs text-destructive">{card.generationError}</p>
          )}
          {card.status === "draft" && card.generationError && (
            <p className="text-xs text-muted-foreground">{card.generationError}</p>
          )}

          <Select
            value={card.assignedTo ?? "unassigned"}
            onValueChange={(value) => handleAssign(value as string)}
            disabled={assigning}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue>{assignedMember ? (assignedMember.name ?? assignedMember.email) : "Unassigned"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {members.map((member) => (
                <SelectItem key={member.userId} value={member.userId}>
                  {member.name ?? member.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {card.status === "brief" && (
            <Button type="button" size="sm" className="w-full" disabled={generating} onClick={handleGenerate}>
              {generating ? "Generating…" : card.generationError ? "Retry generation" : "Generate draft"}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
