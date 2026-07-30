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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  editAtomicUpdate,
  hideAtomicUpdate,
  unhideAtomicUpdate,
  removeEventFromAtomicUpdate,
  setAtomicUpdateCategory,
  setAtomicUpdateSize,
  type AtomicUpdateEvent,
  type AtomicUpdateRow,
} from "./actions";
import type { ImportRepo } from "../change-events/actions";
import { AddEventPicker } from "./add-event-picker";
import { SelectionCheckbox } from "../_components/selection-checkbox";
import { CategoryBadge, CATEGORY_LABEL, SizeBadge } from "./page";

const SIZE_OPTIONS: Array<"s" | "m" | "l" | "xl"> = ["s", "m", "l", "xl"];

const CATEGORY_OPTIONS: Array<"new" | "improvement" | "fix" | "announcement"> = [
  "new",
  "improvement",
  "fix",
  "announcement",
];

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
  repos,
  notionConnected = false,
  selectable = false,
  selected = false,
  anySelected = false,
  onSelectChange,
}: {
  row: AtomicUpdateRow;
  // Repos for the "Add change events" picker in edit mode — that picker shares
  // the import selector (GitHub commits/PRs) and imports the selection straight
  // into this update.
  repos: ImportRepo[];
  notionConnected?: boolean;
  // Controlled by the page: only rendered/enabled when the page is in
  // selection mode for drafting a release.
  selectable?: boolean;
  selected?: boolean;
  // True when any card in the list is selected — reveals this card's checkbox
  // even without hover, so the list shows all boxes together during selection.
  anySelected?: boolean;
  onSelectChange?: (id: string, selected: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [summary, setSummary] = useState(row.summary);
  const [pending, startTransition] = useTransition();
  const [hidePending, startHideTransition] = useTransition();
  const [evidencePending, startEvidenceTransition] = useTransition();
  // Size and category are staged locally while editing and only persisted on
  // Save (below), same as title/summary — picking a value from the dropdown no
  // longer writes through immediately.
  const [size, setSize] = useState(row.size);
  const [category, setCategory] = useState(row.category);
  const [removeConfirm, setRemoveConfirm] = useState<{
    eventId: string;
    emptiedAtomicUpdate: EmptiedAtomicUpdate;
  } | null>(null);

  // Persists everything staged in the edit form in one Save: title/summary
  // always, plus size/category only when they actually changed (each has its
  // own dedicated action — setAtomicUpdateSize also stamps the size freeze —
  // so they can't be folded into editAtomicUpdate's title/summary write).
  function save() {
    startTransition(async () => {
      try {
        await editAtomicUpdate(row.id, { title, summary });
        if (size && size !== row.size) {
          const result = await setAtomicUpdateSize(row.id, size);
          if (!result.ok) toast.error("Could not update size");
        }
        if (category && category !== row.category) {
          const result = await setAtomicUpdateCategory(row.id, category);
          if (!result.ok) toast.error("Could not update category");
        }
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
      const result = await hideAtomicUpdate(row.id);
      if (result.ok) {
        toast.success("Atomic update hidden");
      } else {
        toast.error("Could not hide this atomic update");
      }
    });
  }

  function unhide() {
    startHideTransition(async () => {
      const result = await unhideAtomicUpdate(row.id);
      if (result.ok) {
        toast.success("Atomic update restored");
      } else {
        toast.error("Could not unhide this atomic update");
      }
    });
  }

  return (
    <div
      className={cn(
        "group rounded-lg border p-4",
        // Same dashed grey treatment hidden change events get on
        // /change-events, so "set aside" reads identically on both pages.
        row.hidden && "dashed-outline border-transparent opacity-85"
      )}
    >
      {editing ? (
        <div className="flex flex-col gap-3">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="Summary" />

          <div className="flex gap-2">
            <Select
              value={size ?? undefined}
              onValueChange={(value) => setSize(value as "s" | "m" | "l" | "xl")}
              disabled={pending}
            >
              <SelectTrigger className="w-24" aria-label="Size">
                {/* Resolve the label off the value directly so the trigger and
                    the options render identically (uppercase), regardless of
                    Base UI's item-registration timing. */}
                <SelectValue placeholder="Size">
                  {(value) => (value ? String(value).toUpperCase() : "Size")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SIZE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={category ?? undefined}
              onValueChange={(value) =>
                setCategory(value as "new" | "improvement" | "fix" | "announcement")
              }
              disabled={pending}
            >
              <SelectTrigger className="w-40" aria-label="Category">
                <SelectValue placeholder="Category">
                  {(value) =>
                    value ? (CATEGORY_LABEL[value as string] ?? String(value)) : "Category"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {CATEGORY_LABEL[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Evidence editor: add (via the import selector) / remove the change
              events behind this update. A successful add/remove regenerates the
              title/summary server-side (revalidatePath re-renders this card),
              even overriding a prior hand-edit freeze — see
              add{Commits,PullRequests}ToAtomicUpdate (import-actions.ts) and
              removeEventFromAtomicUpdate (actions.ts). */}
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
              <AddEventPicker atomicUpdateId={row.id} repos={repos} notionConnected={notionConnected} />
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
                setSize(row.size);
                setCategory(row.category);
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
              <SelectionCheckbox
                checked={selected}
                onCheckedChange={(next) => onSelectChange?.(row.id, next)}
                label={`Select "${row.title}"`}
                collapsedMarginClass="-mr-2"
                forceVisible={anySelected}
              />
            )}
            <h2 className="font-medium">{row.title}</h2>
            <CategoryBadge category={row.category} />
            <SizeBadge size={row.size} />
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
            {/* A hidden update is a curation dead-end — the resolver won't
                cluster onto it and it can't be drafted — so editing it or its
                evidence would be busywork. Unhide is the only way forward. */}
            {row.hidden ? (
              <Button variant="ghost" size="sm" disabled={hidePending} onClick={unhide}>
                {hidePending ? "Unhiding…" : "Unhide"}
              </Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button variant="ghost" size="sm" disabled={hidePending} onClick={hide}>
                  {hidePending ? "Hiding…" : "Hide"}
                </Button>
              </>
            )}
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
