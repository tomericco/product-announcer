"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ExternalLink, SquarePlus } from "lucide-react";
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
import type { SelectableEventRow } from "./actions";
import { createFromEvents } from "./actions";

const TYPE_LABEL: Record<SelectableEventRow["type"], string> = {
  commit: "Commit",
  pull_request: "Pull request",
  task: "Task",
};

const PROVIDER_LABEL: Record<SelectableEventRow["provider"], string> = {
  github: "GitHub",
  notion: "Notion",
};

type EmptiedAtomicUpdate = { id: string; title: string; inDraft: boolean };

/**
 * "New atomic update" on `/atomic-updates`: pick a set of change events
 * (unassigned, or currently living in a different OPEN atomic update — see
 * `listSelectableEvents`) and fold them into one brand-new open atomic
 * update. Reuses the checkbox-list pattern from `change-events/import-dialog.tsx`
 * and the needs-confirmation + toast + `useTransition` pattern from
 * `change-events/reassign-control.tsx`.
 *
 * No `db`/pg import here — `events` arrives as a prop, queried server-side by
 * `page.tsx` via `listSelectableEvents()`.
 *
 * A submit that would empty one or more open source atomic updates comes back
 * from `createFromEvents` as `needsConfirmation` rather than silently
 * deleting them: this opens a confirm dialog naming every atomic update that
 * would be emptied (flagging any that are already part of a draft release),
 * then re-posts the same selection with `confirmEmptyDeletion=true`.
 */
export function NewAtomicUpdateDialog({ events }: { events: SelectableEventRow[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [emptiedAtomicUpdates, setEmptiedAtomicUpdates] = useState<EmptiedAtomicUpdate[] | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function reset() {
    setSelected(new Set());
    setEmptiedAtomicUpdates(null);
  }

  function submit(confirmEmptyDeletion: boolean) {
    const formData = new FormData();
    for (const id of selected) formData.append("eventIds", id);
    if (confirmEmptyDeletion) formData.set("confirmEmptyDeletion", "true");

    startTransition(async () => {
      const result = await createFromEvents(formData);

      if (result.ok) {
        setEmptiedAtomicUpdates(null);
        if (result.deletedAtomicUpdates && result.deletedAtomicUpdates.length > 0) {
          toast.success(
            `Atomic update created — deleted ${result.deletedAtomicUpdates.length} emptied atomic update${
              result.deletedAtomicUpdates.length === 1 ? "" : "s"
            }`
          );
        } else {
          toast.success("Atomic update created");
        }
        reset();
        setOpen(false);
        return;
      }

      if ("needsConfirmation" in result && result.needsConfirmation) {
        setEmptiedAtomicUpdates(result.emptiedAtomicUpdates);
        return;
      }

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
            <Button variant="outline" disabled={events.length === 0}>
              <SquarePlus />
              New atomic update
            </Button>
          }
        />
        <DialogContent className="flex max-h-[85dvh] flex-col gap-5 p-6 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New atomic update</DialogTitle>
            <DialogDescription>
              Select the commits, pull requests, and tasks that belong to this change. Events already in
              another open atomic update will be moved.
            </DialogDescription>
          </DialogHeader>

          <div className="h-80 overflow-y-auto rounded-lg border border-border">
            {events.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No selectable change events.</p>
            ) : (
              <ul className="divide-y divide-border">
                {events.map((event) => {
                  const checked = selected.has(event.id);
                  return (
                    <li key={event.id}>
                      <label className="flex cursor-pointer items-start gap-3 px-4 py-3.5 text-sm hover:bg-muted/50">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4 rounded border-input"
                          checked={checked}
                          onChange={() => toggle(event.id)}
                        />
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
                        <Badge variant={event.atomicUpdateTitle ? "secondary" : "outline"} className="shrink-0 self-center">
                          {event.atomicUpdateTitle ?? "Unassigned"}
                        </Badge>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <DialogFooter className="items-center sm:justify-between">
            <span className="text-sm text-muted-foreground">{selected.size} selected</span>
            <div className="flex gap-2">
              <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
                Cancel
              </DialogClose>
              <Button
                type="button"
                onClick={() => submit(false)}
                disabled={selected.size === 0 || pending}
              >
                {pending ? "Creating…" : "Create atomic update"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={emptiedAtomicUpdates !== null}
        onOpenChange={(next) => !next && !pending && setEmptiedAtomicUpdates(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete emptied atomic updates?</DialogTitle>
            <DialogDescription
              render={
                <div>
                  Moving these events will leave the following atomic update
                  {emptiedAtomicUpdates && emptiedAtomicUpdates.length === 1 ? "" : "s"} with no change
                  events, so {emptiedAtomicUpdates && emptiedAtomicUpdates.length === 1 ? "it" : "they"} will
                  be deleted:
                  <ul className="mt-2 list-inside list-disc space-y-1">
                    {emptiedAtomicUpdates?.map((au) => (
                      <li key={au.id}>
                        &quot;{au.title}&quot;
                        {au.inDraft
                          ? " — part of a draft release; deleting it removes a member the draft's body still describes."
                          : null}
                      </li>
                    ))}
                  </ul>
                </div>
              }
            />
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" disabled={pending} />}>Cancel</DialogClose>
            <Button variant="destructive" disabled={pending} onClick={() => submit(true)}>
              {pending ? "Deleting…" : "Delete and create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
