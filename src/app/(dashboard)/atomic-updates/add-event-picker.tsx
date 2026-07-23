"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ExternalLink, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { addEventToAtomicUpdate, type SelectableEventRow } from "./actions";

const TYPE_LABEL: Record<SelectableEventRow["type"], string> = {
  commit: "Commit",
  pull_request: "PR",
  task: "Task",
};

const PROVIDER_LABEL: Record<SelectableEventRow["provider"], string> = {
  github: "GitHub",
  notion: "Notion",
};

type EmptiedAtomicUpdate = { id: string; title: string; inDraft: boolean };

/**
 * "Add change event" control on an atomic update card's evidence editor (edit
 * mode): a picker of every OTHER selectable change event — the card already
 * filtered `events` down to exclude ones already on THIS update (see
 * `atomic-update-card.tsx`'s `addableEvents`) — that folds one into this
 * atomic update on click.
 *
 * Mirrors `NewAtomicUpdateDialog`'s list rendering, but selection is
 * single-click-to-add rather than checkbox-then-submit: there's exactly one
 * destination atomic update here (this card's), so there's nothing to batch
 * against. Also mirrors the needs-confirmation + toast + `useTransition`
 * pattern from `reassign-control.tsx`: picking an event that currently lives
 * in a different OPEN atomic update, when doing so would empty that update,
 * comes back `needsConfirmation` rather than silently deleting it — this
 * opens a confirm dialog naming the source before re-posting the same pick
 * with `confirmEmptyDeletion=true`.
 *
 * No `db`/pg import here — `events` arrives as a prop, ultimately queried
 * server-side by `page.tsx` via `listSelectableEvents()`.
 */
export function AddEventPicker({
  atomicUpdateId,
  events,
}: {
  atomicUpdateId: string;
  events: SelectableEventRow[];
}) {
  const [open, setOpen] = useState(false);
  const [pendingEventId, setPendingEventId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{
    eventId: string;
    emptiedAtomicUpdate: EmptiedAtomicUpdate;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setConfirmState(null);
    setPendingEventId(null);
  }

  function submit(eventId: string, confirmEmptyDeletion: boolean) {
    setPendingEventId(eventId);
    startTransition(async () => {
      const result = await addEventToAtomicUpdate(atomicUpdateId, eventId, confirmEmptyDeletion);

      if (result.ok) {
        if (result.deletedAtomicUpdate) {
          toast.success(
            `Change event added — deleted emptied atomic update "${result.deletedAtomicUpdate.title}"`
          );
        } else {
          toast.success("Change event added");
        }
        reset();
        setOpen(false);
        return;
      }

      if ("needsConfirmation" in result && result.needsConfirmation) {
        setConfirmState({ eventId, emptiedAtomicUpdate: result.emptiedAtomicUpdate });
        return;
      }

      setPendingEventId(null);
      toast.error(result.reason);
    });
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogTrigger
          render={
            <Button type="button" variant="outline" size="sm" disabled={events.length === 0}>
              <Plus />
              Add change event
            </Button>
          }
        />
        <DialogContent className="flex max-h-[85dvh] flex-col gap-5 p-6 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add change event</DialogTitle>
            <DialogDescription>
              Pick a commit, pull request, or task to add as evidence for this atomic update. One
              currently sitting in another open atomic update will be moved here.
            </DialogDescription>
          </DialogHeader>

          <div className="h-80 overflow-y-auto rounded-lg border border-border">
            {events.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No selectable change events.</p>
            ) : (
              <ul className="divide-y divide-border">
                {events.map((event) => (
                  <li key={event.id}>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => submit(event.id, false)}
                      className="flex w-full cursor-pointer items-start gap-3 px-4 py-3.5 text-left text-sm hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="min-w-0 flex-1 space-y-1">
                        <span className="flex items-center gap-1.5">
                          {event.externalUrl ? (
                            <a
                              href={event.externalUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="truncate font-medium text-foreground underline-offset-2 hover:underline"
                            >
                              {event.title}
                            </a>
                          ) : (
                            <span className="truncate font-medium">{event.title}</span>
                          )}
                          {event.externalUrl && (
                            <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                          )}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {TYPE_LABEL[event.type]} · {PROVIDER_LABEL[event.provider]}
                        </span>
                      </span>
                      <Badge
                        variant={event.atomicUpdateTitle ? "secondary" : "outline"}
                        className="shrink-0 self-center"
                      >
                        {pending && pendingEventId === event.id
                          ? "Adding…"
                          : (event.atomicUpdateTitle ?? "Unassigned")}
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
              Close
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmState !== null}
        onOpenChange={(next) => !next && !pending && setConfirmState(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete emptied atomic update?</DialogTitle>
            <DialogDescription>
              {confirmState && (
                <>
                  Adding this event here will leave &quot;{confirmState.emptiedAtomicUpdate.title}&quot; with
                  no change events, so it will be deleted.
                  {confirmState.emptiedAtomicUpdate.inDraft
                    ? " It's part of a draft release; deleting it removes a member the draft's body still describes."
                    : null}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" disabled={pending} />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => confirmState && submit(confirmState.eventId, true)}
            >
              {pending ? "Deleting…" : "Delete and add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
