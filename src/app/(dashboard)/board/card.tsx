"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import Image from "next/image";
import { format } from "date-fns";
import { GripVertical, Trash2 } from "lucide-react";
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
import { GeneratingBadge } from "@/components/generating-badge";

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
  /** Called once a generation has been STARTED from this card — never when
   * one finishes, which this card has no way to know: `generateDraft` returns
   * as soon as the work is queued. The board answers it by opening the
   * generation modal on this piece (the same one a confirmed brief drop
   * opens, and the only thing that polls a run) and re-reading the server.
   * That re-read is not redundant with `generateDraft`'s own
   * `revalidatePath("/board")`: the revalidate runs inside `after()`, so it
   * fires only once the run has landed — long after this response. Delete
   * either one and a card sits on stale data until something else refreshes
   * it. Unused by the brief branch. */
  onGenerated: () => void;
  /** Unused by the brief branch — a brief has no assignee. */
  onAssigned: (userId: string | null) => void;
  /** Called when this card's Delete is pressed — NOT when a delete lands.
   * Nothing is deleted here: the board opens the confirmation and makes the
   * call, for the same reason it owns the accept confirmation (see
   * `pendingDelete` in board.tsx). Both kinds raise it; the board tells them
   * apart by the card it stashed, not by which one called. */
  onDelete: () => void;
};

/** Dispatches on the card's kind. See `Props.card`. */
export function BoardCardItem({ card, members, draggable, onGenerated, onAssigned, onDelete }: Props) {
  if (card.kind === "brief") {
    return <BriefCardItem card={card} draggable={draggable} onDelete={onDelete} />;
  }
  return (
    <PieceCardItem
      card={card}
      members={members}
      draggable={draggable}
      onGenerated={onGenerated}
      onAssigned={onAssigned}
      onDelete={onDelete}
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
      // Collapsed to zero width until the card is hovered, so the title sits
      // flush against the card's own padding instead of behind a permanent
      // gutter reserved for an invisible control. `w-5.5` is the icon plus its
      // spacing, so hovering slides the title by exactly the handle's width.
      //
      // Width and opacity, never `hidden` or `display:none`: the board carries
      // a KeyboardSensor, so this button is the keyboard route into a drag,
      // and a removed element is not focusable — hiding it that way would take
      // keyboard dragging with it. `focus-visible` expands it for anyone
      // tabbing, so it is a real target at the moment it is focused rather
      // than a zero-width one.
      className="mt-0.5 w-0 shrink-0 cursor-grab overflow-hidden opacity-0 transition-all touch-none text-muted-foreground hover:text-foreground focus-visible:w-5.5 focus-visible:opacity-100 active:cursor-grabbing group-hover/card:w-5.5 group-hover/card:opacity-100"
      aria-label={`Move ${title}`}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-4 mr-1.5" />
    </button>
  );
}

/**
 * Shared by both card kinds: Delete. It opens a confirmation on the board
 * and deletes nothing itself — see `Props.onDelete`.
 *
 * Revealed on hover like the drag handle, and for the same reasons kept in
 * the layout rather than removed: `focus-visible` brings it back for anyone
 * tabbing, so the one irreversible action on a card is never pointer-only.
 * Unlike the handle it keeps its width at rest — a destructive control that
 * changes the card's layout as the pointer arrives is how the wrong card
 * gets clicked.
 *
 * `aria-label` carries the accessible name: a bare icon has none, and
 * "Delete" alone would be ambiguous on a board of near-identical cards.
 */
function DeleteButton({ title, onDelete }: { title: string; onDelete: () => void }) {
  return (
    <button
      type="button"
      className="ml-1.5 mt-0.5 shrink-0 cursor-pointer opacity-0 transition-opacity text-muted-foreground hover:text-destructive focus-visible:opacity-100 group-hover/card:opacity-100"
      aria-label={`Delete ${title}`}
      onClick={onDelete}
    >
      <Trash2 className="size-4" />
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
 * acceptance gesture on the board now: the Accept button this card used to
 * carry is gone, so there is exactly one way to spend the model call from
 * here rather than two. (`/briefs/[briefId]` still has its own Accept —
 * `DecisionButtons` in `brief-header.tsx` — for the editor's read-then-decide
 * flow; this claim is about the board card, not the app as a whole.) The
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
function BriefCardItem({
  card,
  draggable,
  onDelete,
}: {
  card: BoardBriefCard;
  draggable: boolean;
  onDelete: () => void;
}) {
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
          <div className="flex items-start">
            {draggable && (
              <DragHandle title={card.title} attributes={attributes} listeners={listeners} />
            )}
            <Link
              href={`/briefs/${card.id}`}
              className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
            >
              {card.title}
            </Link>
            {/* Always offered on a brief. `readBoard` renders only
                `status = "new"` briefs, and `deleteBrief` refuses exactly one
                status — `accepted` — which can therefore never appear here.
                (Deleting a brief is not dismissing it: see `deleteBrief`'s
                doc comment, and the confirmation the board opens says so.) */}
            <DeleteButton title={card.title} onDelete={onDelete} />
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
  onDelete,
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
  // while a run is still in flight would report a running generation as
  // broken.
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
      // here. The modal the board opens next reports that, and the failure
      // too — nothing on this card does.
      toast.success("Generation started");
      // Hands the run to the board, which opens the generation modal on this
      // piece and re-reads the server. The refetch alone is not enough: the
      // poll and the loader are the same object now, so a Generate that only
      // refreshed would leave the person who pressed it looking at a
      // "Generating…" badge with nothing watching the run behind it. The step
      // is already written, so that refetch reliably sees it and the card
      // swaps this button for the badge underneath the modal.
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
        {/* The piece's cover (spec §3). It must stay the FIRST child of
            `Card`: the primitive drops its own top padding and rounds the
            top corners for a direct first-child <img>
            (`has-[>img:first-child]:pt-0`, `*:[img:first-child]:rounded-t-xl`
            — src/components/ui/card.tsx:16), which is what makes this sit
            flush instead of inside the card's padding. Moving it below
            CardContent, or wrapping it in a div, turns both rules off with
            no error.

            Rendered only when there is one, and that is the common case
            inverted: product updates and social posts have no cover at all
            (spec §6), and neither does a piece whose cover generation
            failed. Those cards keep exactly today's layout, because the two
            rules above are conditional selectors that simply do not match.

            `width`/`height` are the cover's real 1200x630 (never cropped —
            product owner decision 1), so the browser reserves the 1.91:1 box
            from the attributes and the card does not jump when the image
            lands. `sizes` keeps a ~300px column from pulling the 1200px
            master.

            `alt=""` — the cover is decorative HERE (spec §2). The card's
            accessible name is the title link immediately below it; the
            row's real alt text rides along on `card.cover.alt` for anything
            that needs it, and is what Task 9's dialog edits and Plan 4
            publishes. */}
        {card.cover && (
          <Image
            src={card.cover.url}
            alt=""
            width={1200}
            height={630}
            sizes="(max-width: 1024px) 50vw, 320px"
            className="h-auto w-full"
          />
        )}
        <CardContent className="space-y-2">
          <div className="flex items-start">
            {draggable && (
              <DragHandle title={card.title} attributes={attributes} listeners={listeners} />
            )}
            <Link
              href={`/drafts/${card.id}`}
              className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
            >
              {card.title}
            </Link>
            {/* Mirrors `assertDraftDeletable` exactly, and nothing more: it
                refuses only `published` (the record of what shipped), and
                deliberately ADMITS `brief` — a generation that can never
                succeed is a card whose only other control is Generate, so
                removing this one would strand it. It never consults
                `reviewStatus`, which this card does not even carry, so a
                piece is deletable at any review outcome. Not offered rather
                than offered-and-refused: a control that can only ever toast
                an error is worse than no control. */}
            {card.status !== "published" && <DeleteButton title={card.title} onDelete={onDelete} />}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{CONTENT_TYPE_LABEL[card.type]}</Badge>

            {/* A "brief" card with generationError is a failed generation —
                the scaffold body is intact and Generate below offers a retry.
                Unless it is generating right now, in which case that error is
                the pre-model marker and not a failure at all (see
                `generating`) — and the badge is a control rather than a label,
                because the stepped loader now lives only in the modal it
                opens. The other two states stay plain badges: there is nothing
                in flight to watch. */}
            {card.status === "brief" &&
              (generating ? (
                <GeneratingBadge contentPieceId={card.id} title={card.title} />
              ) : (
                <Badge variant={card.generationError ? "destructive" : "outline"}>
                  {card.generationError ? "Generation failed" : "Awaiting generation"}
                </Badge>
              ))}

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
              The "Generating…" badge above stands in for it, and opens the
              modal that shows how far the run has got. */}
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
