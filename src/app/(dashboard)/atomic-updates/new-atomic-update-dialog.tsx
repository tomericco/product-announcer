"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { SquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { EventMultiSelect, type PickerRow, type PickerType } from "../_components/event-multi-select";
import type { SelectableEventRow } from "./actions";
import { createFromEvents } from "./actions";

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
 * "New atomic update" on `/atomic-updates`: pick a set of change events
 * (unassigned, or currently living in a different OPEN atomic update — see
 * `listSelectableEvents`) via the shared `EventMultiSelect` — the same view as
 * the change-events importer and the per-update "add change events" picker —
 * and group them into one brand-new open atomic update.
 *
 * The `events` prop is a static snapshot (no reload while the dialog is open),
 * so selection is a plain `Set<string>` of event ids. Events are filtered to
 * the active type-dropdown value; submitting groups the whole selection in one
 * `createFromEvents` call.
 *
 * No `db`/pg import here — `events` arrives as a prop, queried server-side by
 * `page.tsx` via `listSelectableEvents()`.
 *
 * A submit that would empty one or more open source atomic updates comes back
 * from `createFromEvents` as `needsConfirmation` rather than silently deleting
 * them: this opens a confirm dialog naming every atomic update that would be
 * emptied (flagging any already part of a draft release), then re-posts the
 * same selection with `confirmEmptyDeletion=true`.
 */
export function NewAtomicUpdateDialog({ events }: { events: SelectableEventRow[] }) {
  const [open, setOpen] = useState(false);
  const [pickerType, setPickerType] = useState<PickerType>("commit");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [confirmState, setConfirmState] = useState<{
    eventIds: string[];
    emptiedAtomicUpdates: EmptiedAtomicUpdate[];
  } | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setSelected(new Set());
    setSearch("");
    setPickerType("commit");
    setConfirmState(null);
  }

  function submit(eventIds: string[], confirmEmptyDeletion: boolean) {
    const formData = new FormData();
    for (const id of eventIds) formData.append("eventIds", id);
    if (confirmEmptyDeletion) formData.set("confirmEmptyDeletion", "true");

    startTransition(async () => {
      const result = await createFromEvents(formData);

      if (result.ok) {
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
        setConfirmState({ eventIds, emptiedAtomicUpdates: result.emptiedAtomicUpdates });
        return;
      }

      toast.error(result.reason);
    });
  }

  const filteredEvents = events.filter((event) => event.type === pickerType);
  const rows: PickerRow[] = filteredEvents.map((event) => ({
    key: event.id,
    title: event.title,
    meta: `${TYPE_LABEL[event.type]} · ${PROVIDER_LABEL[event.provider]}`,
    externalUrl: event.externalUrl,
    badge: event.atomicUpdateTitle ?? "Unassigned",
  }));

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
              Select the commits or pull requests that belong to this change. Events already in
              another open atomic update will be moved.
            </DialogDescription>
          </DialogHeader>

          <EventMultiSelect
            activeType={pickerType}
            onTypeChange={(t) => {
              setPickerType(t);
              setSelected(new Set());
            }}
            enabledTypes={["commit", "pull_request"]}
            rows={rows}
            emptyLabel="No selectable change events."
            selected={selected}
            onSelectedChange={setSelected}
            search={search}
            onSearchChange={setSearch}
            submitLabel={pending ? "Creating…" : `Create atomic update${selected.size > 0 ? ` (${selected.size})` : ""}`}
            submitting={pending}
            onSubmit={() => submit(Array.from(selected), false)}
            secondaryAction={
              <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
                Cancel
              </DialogClose>
            }
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmState !== null}
        onOpenChange={(next) => !next && !pending && setConfirmState(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete emptied atomic update(s)?</DialogTitle>
            <DialogDescription>
              {confirmState && (
                <>
                  Moving these events will leave{" "}
                  {confirmState.emptiedAtomicUpdates.map((au, i) => (
                    <span key={au.id}>
                      {i > 0 && ", "}
                      &quot;{au.title}&quot;
                    </span>
                  ))}{" "}
                  with no change events, so{" "}
                  {confirmState.emptiedAtomicUpdates.length === 1 ? "it" : "they"} will be deleted.
                  {confirmState.emptiedAtomicUpdates.some((au) => au.inDraft)
                    ? " At least one is part of a draft release; deleting it removes a member the draft's body still describes."
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
              onClick={() => confirmState && submit(confirmState.eventIds, true)}
            >
              {pending ? "Deleting…" : "Delete and create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
