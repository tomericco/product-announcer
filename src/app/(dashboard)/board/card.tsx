"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
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
import type { BoardBriefCard, BoardCard as BoardCardType } from "@/lib/content/board";
import type { WorkspaceMember } from "@/lib/workspace/members";
// `generateDraft` is a "use server" export — importing it here wires the
// button straight to the server action, the same pattern
// drafts/[releaseId]/generate-draft-button.tsx already uses. No runtime
// value from a server *module* crosses the boundary; this is a Server
// Function reference, which is how Next.js expects client code to invoke one.
import { generateDraft } from "../briefs/actions";
import { assignCard } from "./actions";
import { GenerationChecklist } from "@/components/generation-checklist";

// The scheduled badge must show the piece's LOCAL wall-clock time (the
// spec's requirement — see the picker in board.tsx), which rules out pinning
// a fixed zone the way signal-row.tsx's DATE_FORMAT does. A local zone
// differs between the server's render and the browser's, so formatting
// straight from `card.scheduledFor` on the first client render would
// mismatch the HTML sent down and trip a hydration warning.
//
// Same pattern as webflow-code-warning.tsx's useDismissed: useSyncExternalStore
// with a server snapshot that always returns false, so the server render and
// React's first client render (before hydration settles) agree, and the real
// value only takes effect once hydration has actually finished. Plain
// useState+useEffect (calling setState from inside the effect body) was the
// other option, but it causes an extra synchronous re-render on every mount
// that the lint rule (react-hooks/set-state-in-effect) flags for exactly
// that reason; useSyncExternalStore doesn't have that cost.
// suppressHydrationWarning was rejected outright: it only silences the
// warning, it does not force a re-render, so the server's (wrong-zone) text
// would keep sitting on screen indefinitely instead of ever correcting to
// the viewer's local time.
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

const CONTENT_TYPE_LABEL: Record<BoardCardType["type"], string> = {
  product_update: "Product update",
  blog_post: "Blog post",
  social_post: "Social post",
};

type Props = {
  /** The board carries two object types; this is the branch point. A brief
   * is a commission with no assignee, schedule or generation state, so it
   * gets its own component rather than a piece card with everything nulled
   * out — the discriminant is what keeps the two apart. */
  card: BoardCardType | BoardBriefCard;
  members: WorkspaceMember[];
  /** False for a piece mid-generation (no drag out — Generate is its only
   * exit) and for `published` (terminal, read-only). True for a brief, whose
   * one exit is a drag onto Draft — the board passes it per card, since the
   * two kinds are drag-eligible under different rules. */
  draggable: boolean;
  /** Called after a successful generation so the board can pick up the
   * piece's new status and body — `generateDraft` only revalidates /drafts
   * and /drafts/[id], not /board. Unused by the brief branch. */
  onGenerated: () => void;
  /** Unused by the brief branch — a brief has no assignee. */
  onAssigned: (userId: string | null) => void;
};

/** Dispatches on the card's kind. See `Props.card`. */
export function BoardCardItem({ card, members, draggable, onGenerated, onAssigned }: Props) {
  if (card.kind === "brief") {
    return <BriefCardItem card={card} draggable={draggable} />;
  }
  return (
    <PieceCardItem
      card={card}
      members={members}
      draggable={draggable}
      onGenerated={onGenerated}
      onAssigned={onAssigned}
    />
  );
}

/**
 * Shared by both card kinds: the same small grip that owns the drag, so a
 * card is never picked up by its title link or its assignee select. Rendered
 * only when the card is actually draggable — a handle for a drag that cannot
 * happen is worse than no handle.
 */
function DragHandle({
  title,
  attributes,
  listeners,
}: {
  title: string;
  /** Taken straight off `useDraggable` rather than restated, so this cannot
   * drift from whatever the library hands back. */
  attributes: ReturnType<typeof useDraggable>["attributes"];
  listeners: ReturnType<typeof useDraggable>["listeners"];
}) {
  return (
    <button
      type="button"
      className="mt-0.5 shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
      aria-label={`Move ${title}`}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-4" />
    </button>
  );
}

/**
 * A brief card: a commission that has not been accepted yet. Same chrome as
 * a piece card (grip, linked title, badge row) rather than a second visual
 * language — only the badges differ, and the title links to the brief editor
 * at `/briefs/[briefId]`, not to a draft that does not exist yet.
 *
 * **It drags, and Draft is the only place it can go.** That is the whole
 * acceptance gesture now: the Accept button this card used to carry is gone,
 * so there is exactly one way to spend the model call rather than two. The
 * refusal is not implemented here — the board disables every other column's
 * `useDroppable` while a brief is in hand (`canDrop` in board.tsx), which is
 * the same mechanism the piece moves already use, and `collision.ts` is what
 * makes a release outside the one enabled column resolve to nothing.
 *
 * The confirmation, the acceptance call and the generation modal all live on
 * the board too, not here: accepting removes this card, so anything mounted
 * inside it would be torn down by the very refetch that proves the accept
 * worked. (See `pendingAccept` in board.tsx, which also carries the note on
 * why a confirmation still stands behind a deliberate gesture.)
 */
function BriefCardItem({ card, draggable }: { card: BoardBriefCard; draggable: boolean }) {
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

  return (
    <div ref={setNodeRef} style={style} className={cn(isDragging && "opacity-40")}>
      <Card size="sm">
        <CardContent className="space-y-2">
          <div className="flex items-start gap-1.5">
            {draggable && (
              <DragHandle title={card.title} attributes={attributes} listeners={listeners} />
            )}
            <Link
              href={`/briefs/${card.id}`}
              className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
            >
              {card.title}
            </Link>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {/* `briefs.contentType` and `contentPieces.type` are the same
                pg enum, so the label map above covers both. */}
            <Badge variant="secondary">{CONTENT_TYPE_LABEL[card.contentType]}</Badge>
            {/* Same two-decimal form the old /briefs inbox rows used. */}
            <Badge variant="outline">{card.score.toFixed(2)}</Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * One content piece on the board. The drag handle is a small grip icon, not
 * the whole card — the title links to `/drafts/[id]` and the assignee picker
 * is an interactive `<Select>`, and attaching dnd-kit's pointer listeners to
 * the entire card would fight both of those for the initial pointerdown.
 */
function PieceCardItem({
  card,
  members,
  draggable,
  onGenerated,
  onAssigned,
}: Omit<Props, "card"> & { card: BoardCardType }) {
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

  const [starting, startGenerate] = useTransition();
  const [assigning, setAssigning] = useState(false);
  const hydrated = useHydrated();

  // Generating RIGHT NOW — which changes how the rest of this card reads.
  // `generationError` is non-null for the whole run (the
  // interrupted-generation marker `generateDraftForPiece` writes BEFORE the
  // model call, deliberately), so it describes a previous attempt's worst
  // case, not the current one. Badging or printing it as a landed failure
  // beside a live checklist reported a running generation as broken.
  //
  // Server state ONLY. This briefly also OR'd in a local "I just started one"
  // flag to cover the gap before the first step write landed; because nothing
  // ever reset it, a FAILED generation left the card stuck on "Generating…"
  // with its real error suppressed and no Generate button, recoverable only by
  // a full browser reload (router.refresh() keeps client state — the card
  // never remounts). `queueGeneration` now writes the step before the action
  // returns, so there is no gap left to cover and no flag to get stuck.
  const generating = card.status === "brief" && card.generationStep !== null;

  function handleGenerate() {
    startGenerate(async () => {
      const result = await generateDraft(card.id);
      // A refusal is knowable synchronously — `queueGeneration` checks
      // eligibility in the same statement that claims the piece.
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      // "Started", not "done". `generateDraft` is fire-and-forget: it returns
      // as soon as the work is queued, so there is no completion to report
      // here. The checklist reports that, and the failure too.
      toast.success("Generation started");
      // The step is already written, so this refetch reliably sees it and the
      // card swaps the button for the checklist.
      onGenerated();
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
              <DragHandle title={card.title} attributes={attributes} listeners={listeners} />
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
                the scaffold body is intact and Generate below offers a retry.
                Unless it is generating right now, in which case that error is
                the pre-model marker and not a failure at all (see
                `generating`). */}
            {card.status === "brief" && (
              <Badge variant={!generating && card.generationError ? "destructive" : "outline"}>
                {generating
                  ? "Generating…"
                  : card.generationError
                    ? "Generation failed"
                    : "Awaiting generation"}
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
              <Badge variant="outline">{hydrated ? format(card.scheduledFor, "d MMM, HH:mm") : "—"}</Badge>
            )}
          </div>

          {card.status === "brief" && card.generationError && !generating && (
            <p className="text-xs text-destructive">{card.generationError}</p>
          )}
          {card.status === "draft" && card.generationError && (
            <p className="text-xs text-muted-foreground">{card.generationError}</p>
          )}

          {/* Only while a generation is actually in flight — a brief that
              hasn't been generated yet (generationStep null, no error) shows
              just the "Awaiting generation" badge above, not a half-lit
              checklist. A run this card just kicked off is already covered:
              the step is written before the action returns. */}
          {generating && <GenerationChecklist contentPieceId={card.id} />}

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

          {/* Hidden, not merely disabled, while a run is in flight. The action
              resolves in milliseconds now that it only queues the work, so
              `disabled={starting}` alone would leave the button live for the
              whole generation and invite a second click. A click after the run
              lands is refused by `generateDraftForPiece`'s status guard (the
              piece is "draft" by then, and the generator is never called); a
              click DURING the run is the weaker case, since that guard is a
              read-then-act and two overlapping runs can both pass it. Removing
              the control is what makes the second one unreachable from here.
              The checklist above stands in for it. */}
          {card.status === "brief" && !generating && (
            <Button type="button" size="sm" className="w-full" disabled={starting} onClick={handleGenerate}>
              {starting ? "Starting…" : card.generationError ? "Retry generation" : "Generate draft"}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
