"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  editAtomicUpdate,
  markAtomicUpdateHidden,
  removeEventFromAtomicUpdate,
  type AtomicUpdateEvent,
  type AtomicUpdateRow,
  type SelectableEventRow,
} from "./actions";
import { AddEventPicker } from "./add-event-picker";
import { CategoryBadge } from "./page";

type EmptiedAtomicUpdate = { id: string; title: string; inDraft: boolean };

const EVENT_TYPE_LABEL: Record<AtomicUpdateEvent["type"], string> = {
  commit: "Commit",
  pull_request: "PR",
  task: "Task",
};

function EventRow({ event }: { event: AtomicUpdateEvent }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Badge variant="secondary" className="shrink-0">
        {EVENT_TYPE_LABEL[event.type]}
      </Badge>
      {event.externalUrl ? (
        <a
          href={event.externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate hover:underline"
        >
          {event.label}
        </a>
      ) : (
        <span className="truncate text-muted-foreground">{event.label}</span>
      )}
    </div>
  );
}

export function AtomicUpdateCard({
  row,
  selectableEvents = [],
  selectable = false,
  selected = false,
  onSelectChange,
}: {
  row: AtomicUpdateRow;
  // Candidate pool for the "Add change event" picker in edit mode — every
  // change event selectable across the tenant, queried once by the page and
  // filtered down here to exclude events already on THIS update. Optional/
  // defaulted so callers that never enter edit mode (there are none today,
  // but this keeps the prop non-breaking) don't have to pass it.
  selectableEvents?: SelectableEventRow[];
  // Controlled by the page: only rendered/enabled when the page is in
  // selection mode for drafting a release.
  selectable?: boolean;
  selected?: boolean;
  onSelectChange?: (id: string, selected: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [summary, setSummary] = useState(row.summary);
  const [pending, startTransition] = useTransition();
  const [hidePending, startHideTransition] = useTransition();
  const [evidencePending, startEvidenceTransition] = useTransition();
  const [removeConfirm, setRemoveConfirm] = useState<{
    eventId: string;
    emptiedAtomicUpdate: EmptiedAtomicUpdate;
  } | null>(null);

  function save() {
    startTransition(async () => {
      try {
        await editAtomicUpdate(row.id, { title, summary });
        setEditing(false);
        toast.success("Atomic update saved");
      } catch (error) {
        // Server actions reject with an opaque digest in production; surface
        // what we can rather than leaving the form silently stuck.
        toast.error(error instanceof Error ? error.message : "Something went wrong");
      }
    });
  }

  function removeEvent(eventId: string, confirmEmptyDeletion: boolean) {
    startEvidenceTransition(async () => {
      const result = await removeEventFromAtomicUpdate(row.id, eventId, confirmEmptyDeletion);

      if (result.ok) {
        setRemoveConfirm(null);
        if (result.deletedAtomicUpdate) {
          toast.success(`Removed — deleted emptied atomic update "${result.deletedAtomicUpdate.title}"`);
        } else {
          toast.success("Change event removed");
        }
        return;
      }

      if ("needsConfirmation" in result && result.needsConfirmation) {
        setRemoveConfirm({ eventId, emptiedAtomicUpdate: result.emptiedAtomicUpdate });
        return;
      }

      toast.error(result.reason);
    });
  }

  function hide() {
    startHideTransition(async () => {
      const result = await markAtomicUpdateHidden(row.id);
      if (result.ok) {
        toast.success("Marked as not user-facing");
      } else {
        toast.error("Could not hide this atomic update");
      }
    });
  }

  // The events already on this update are ineligible as "add" candidates —
  // adding an event already here would be a no-op the core would happily
  // perform, but offering it as a picker choice is just clutter (mirrors the
  // same self-filter in reassign-control.tsx's move-target list).
  const addableEvents = selectableEvents.filter((event) => event.atomicUpdateId !== row.id);

  return (
    <div className="rounded-lg border p-4">
      {editing ? (
        <div className="flex flex-col gap-3">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="Summary" />

          {/* Evidence editor: add/remove the change events behind this update.
              A successful add/remove regenerates the title/summary server-side
              (revalidatePath in the actions re-renders this card), even
              overriding a prior hand-edit freeze — see addEventsToAtomicUpdate /
              removeEventFromAtomicUpdate in actions.ts. */}
          <div className="flex flex-col gap-1.5 border-t pt-2">
            <span className="text-xs font-medium text-muted-foreground">Evidence</span>
            {row.events.length === 0 && (
              <p className="text-xs text-muted-foreground">No change events yet.</p>
            )}
            {row.events.map((event) => (
              <div key={event.id} className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <EventRow event={event} />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={evidencePending}
                  onClick={() => removeEvent(event.id, false)}
                >
                  Remove
                </Button>
              </div>
            ))}
            <div>
              <AddEventPicker atomicUpdateId={row.id} events={addableEvents} />
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setTitle(row.title);
                setSummary(row.summary);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            {selectable && (
              <input
                type="checkbox"
                className="size-4 rounded border-input"
                aria-label={`Select "${row.title}"`}
                checked={selected}
                onChange={(e) => onSelectChange?.(row.id, e.target.checked)}
              />
            )}
            <h2 className="font-medium">{row.title}</h2>
            <CategoryBadge category={row.category} />
          </div>
          <p className="text-sm text-muted-foreground">{row.summary}</p>
          {row.events.length > 0 && (
            <div className="flex flex-col gap-1.5 border-t pt-2">
              {row.events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </div>
          )}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              {row.events.length} {row.events.length === 1 ? "change" : "changes"}
            </span>
            {/* Signals to the user why this one stopped auto-updating. */}
            {row.summaryEditedAt && <span>Edited</span>}
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" disabled={hidePending} onClick={hide}>
              {hidePending ? "Hiding…" : "Mark not user-facing"}
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={removeConfirm !== null}
        onOpenChange={(next) => !next && !evidencePending && setRemoveConfirm(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete emptied atomic update?</DialogTitle>
            <DialogDescription>
              {removeConfirm && (
                <>
                  Removing this change event will leave &quot;{removeConfirm.emptiedAtomicUpdate.title}&quot;
                  with no change events, so it will be deleted.
                  {removeConfirm.emptiedAtomicUpdate.inDraft
                    ? " It's part of a draft release; deleting it removes a member the draft's body still describes."
                    : null}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" disabled={evidencePending} />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={evidencePending}
              onClick={() => removeConfirm && removeEvent(removeConfirm.eventId, true)}
            >
              {evidencePending ? "Deleting…" : "Delete and remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
