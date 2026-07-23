"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
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
import { addEventsToAtomicUpdate, type SelectableEventRow } from "./actions";

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
 * "Add change events" control on an atomic update card's evidence editor
 * (edit mode): a multi-select picker, via the shared `EventMultiSelect`, of
 * every OTHER selectable change event — the card already filtered `events`
 * down to exclude ones already on THIS update (see `atomic-update-card.tsx`'s
 * `addableEvents`) — that folds the whole batch into this atomic update in
 * ONE submit, regenerating the summary once rather than once per event.
 *
 * The `events` prop is a static snapshot (no reload while the dialog is
 * open), so selection is a plain `Set<string>` of event ids — unlike the
 * import dialog's `Map`, there's no per-row payload to carry alongside the
 * key.
 *
 * Mirrors the needs-confirmation + toast + `useTransition` pattern from
 * `reassign-control.tsx` / the prior single-add version of this component:
 * a batch that would empty one or more source atomic updates comes back
 * `needsConfirmation` rather than silently deleting them — this opens a
 * confirm dialog naming every source before re-submitting the same selection
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
    startTransition(async () => {
      const result = await addEventsToAtomicUpdate(atomicUpdateId, eventIds, confirmEmptyDeletion);

      if (result.ok) {
        if (result.deletedAtomicUpdates && result.deletedAtomicUpdates.length > 0) {
          const names = result.deletedAtomicUpdates.map((au) => `"${au.title}"`).join(", ");
          toast.success(`Change events added — deleted emptied atomic update(s): ${names}`);
        } else {
          toast.success("Change events added");
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
            <Button type="button" variant="outline" size="sm" disabled={events.length === 0}>
              <Plus />
              Add change events
            </Button>
          }
        />
        <DialogContent className="flex max-h-[85dvh] flex-col gap-5 p-6 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add change events</DialogTitle>
            <DialogDescription>
              Pick commits or pull requests to add as evidence for this atomic update. Ones currently
              sitting in another open atomic update will be moved here.
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
            submitLabel={pending ? "Regenerating…" : `Add ${selected.size} event${selected.size === 1 ? "" : "s"}`}
            submitting={pending}
            onSubmit={() => submit(Array.from(selected), false)}
          />

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
            <DialogTitle>Delete emptied atomic update(s)?</DialogTitle>
            <DialogDescription>
              {confirmState && (
                <>
                  Adding these events here will leave{" "}
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
              {pending ? "Deleting…" : "Delete and add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
