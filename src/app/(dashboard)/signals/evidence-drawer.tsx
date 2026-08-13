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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
// Type-only. `@/lib/signals/evidence` has a top-level `db` import (it's
// `readSignalEvidence`'s home) — Next does not tree-shake an unused runtime
// import out of a client bundle, so pulling any *value* export from that
// module in here would drag `pg` into the browser. `import type` erases
// entirely at compile time. The actual data comes from `loadSignalEvidence`,
// a "use server" action below — a Server Function reference, not a runtime
// value out of a server module.
import type { SignalEvidence, EvidenceEvent } from "@/lib/signals/evidence";
import {
  loadSignalEvidence,
  saveEvidenceEdit,
  saveEvidenceSize,
  saveEvidenceCategory,
  hideEvidenceAtomicUpdate,
  removeEvidenceEvent,
} from "./evidence-actions";

const SIZE_OPTIONS: Array<NonNullable<SignalEvidence["size"]>> = ["s", "m", "l", "xl"];

const CATEGORY_OPTIONS: Array<NonNullable<SignalEvidence["category"]>> = [
  "new",
  "improvement",
  "fix",
  "announcement",
];

// Duplicated locally rather than imported from `../atomic-updates/page` (the
// only other place this table exists): that page backs the "Atomic updates"
// tab the design doc marks for retirement, and this drawer is meant to
// outlive it, so it doesn't lean on that module staying around.
const CATEGORY_LABEL: Record<string, string> = {
  new: "New",
  improvement: "Improvement",
  fix: "Fix",
  announcement: "Announcement",
};

type EmptiedAtomicUpdate = { id: string; title: string; inDraft: boolean };

/**
 * What the drawer body renders. `"idle"` is the closed/not-yet-opened state;
 * opening moves it to `"loading"`, and the load result lands on either
 * `"empty"` (the signal has no atomic update — deleted, or never had one) or
 * `"loaded"`. Exported so the pure helpers below are directly testable
 * without jsdom (see the note above `shouldFetchOnOpen`).
 */
export type EvidenceLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty" }
  | { status: "loaded"; evidence: SignalEvidence };

/**
 * Derives the post-load state from `loadSignalEvidence`'s result. A `null`
 * result — no atomic update behind this signal — renders the no-evidence
 * state rather than throwing; there is nothing exceptional about it (see
 * `readSignalEvidence`'s docstring: it's the expected shape for a deleted
 * atomic update, not an error).
 */
export function loadStateFromResult(evidence: SignalEvidence | null): EvidenceLoadState {
  return evidence ? { status: "loaded", evidence } : { status: "empty" };
}

/**
 * Whether transitioning the dialog's `open` prop to `next` should trigger a
 * fetch. Fetches exactly once per open: `true` only when opening (`next`)
 * from `"idle"`, so a re-render while already `"loading"`/`"loaded"`/`"empty"`
 * never double-fires the request. `handleOpenChange` resets state back to
 * `"idle"` on every close, so the NEXT open fetches fresh — curation done
 * from another drawer, or the Atomic updates tab, in between opens should be
 * visible rather than showing a stale snapshot from the first open.
 */
export function shouldFetchOnOpen(open: boolean, state: EvidenceLoadState): boolean {
  return open && state.status === "idle";
}

function EventRow({
  event,
  onRemove,
  removing,
}: {
  event: EvidenceEvent;
  onRemove: () => void;
  removing: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <div className="min-w-0 flex-1">
        {event.externalUrl ? (
          <a
            href={event.externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate hover:underline"
          >
            {event.label}
          </a>
        ) : (
          <span className="block truncate text-muted-foreground">{event.label}</span>
        )}
      </div>
      <Button variant="ghost" size="sm" disabled={removing} onClick={onRemove}>
        {removing ? "Removing…" : "Remove"}
      </Button>
    </div>
  );
}

/**
 * The evidence drawer behind a `shipped_work` signal: the atomic update it
 * mirrors, plus the change events behind that update, with the same curation
 * actions the (soon-to-be-retired) Atomic updates tab offers — edit
 * title/summary, set size/category, hide, remove a change event.
 *
 * Evidence loads on open via a server action, not embedded in the signals
 * list payload — most rows never get expanded, so the list page must not pay
 * for evidence nobody asked for.
 *
 * `title` is the SIGNAL's own title (a prop from the row), used only to
 * identify which row this drawer belongs to in the dialog chrome. Everything
 * editable inside — title, summary, category, size — is the ATOMIC UPDATE's
 * own value, seeded from the load and kept in local state across a save, so
 * an edit is visible right where it was made. It deliberately does NOT patch
 * the signal's own title/excerpt: those columns are only ever written by the
 * `syncShippedWorkSignals` cron reconciler, which stays their single writer,
 * so this drawer's chrome heading (the signal's title) is intentionally left
 * unchanged by a save here — showing it updated would be a lie until that
 * job next runs.
 */
export function EvidenceDrawer({ signalId, title }: { signalId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<EvidenceLoadState>({ status: "idle" });
  const [loadPending, startLoadTransition] = useTransition();
  const [savePending, startSaveTransition] = useTransition();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<{
    eventId: string;
    emptiedAtomicUpdate: EmptiedAtomicUpdate;
  } | null>(null);

  const [draftTitle, setDraftTitle] = useState("");
  const [draftSummary, setDraftSummary] = useState("");
  const [draftSize, setDraftSize] = useState<SignalEvidence["size"]>(null);
  const [draftCategory, setDraftCategory] = useState<SignalEvidence["category"]>(null);

  // Seeds the draft fields the moment a fresh load lands — set here, at the
  // point the new "loaded" state is computed, rather than in an effect keyed
  // on `state`: setting state synchronously inside an effect body is exactly
  // the cascading-render pattern the react-hooks lint rule (and React's own
  // docs) warn against, and there's no external system to synchronize with
  // here, just two pieces of local state that change together.
  function handleOpenChange(next: boolean) {
    if (shouldFetchOnOpen(next, state)) {
      setState({ status: "loading" });
      startLoadTransition(async () => {
        const result = await loadSignalEvidence(signalId);
        const nextState = loadStateFromResult(result);
        setState(nextState);
        if (nextState.status === "loaded") {
          setDraftTitle(nextState.evidence.title);
          setDraftSummary(nextState.evidence.summary);
          setDraftSize(nextState.evidence.size);
          setDraftCategory(nextState.evidence.category);
        }
      });
    }
    if (!next) {
      setState({ status: "idle" });
      setRemoveConfirm(null);
    }
    setOpen(next);
  }

  function save() {
    if (state.status !== "loaded") return;
    const evidence = state.evidence;

    startSaveTransition(async () => {
      try {
        await saveEvidenceEdit(evidence.atomicUpdateId, { title: draftTitle, summary: draftSummary });

        if (draftSize && draftSize !== evidence.size) {
          const result = await saveEvidenceSize(evidence.atomicUpdateId, draftSize);
          if (!result.ok) toast.error("Could not update size");
        }
        if (draftCategory && draftCategory !== evidence.category) {
          const result = await saveEvidenceCategory(evidence.atomicUpdateId, draftCategory);
          if (!result.ok) toast.error("Could not update category");
        }

        // Reflects the edit in the drawer's own state immediately — the
        // signal row this drawer hangs off never re-fetches (see the
        // docstring above), so this local update is the only thing that
        // makes the save visible before the next page load.
        setState({
          status: "loaded",
          evidence: { ...evidence, title: draftTitle, summary: draftSummary, size: draftSize, category: draftCategory },
        });
        toast.success("Saved");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Something went wrong");
      }
    });
  }

  function hide() {
    if (state.status !== "loaded") return;
    const evidence = state.evidence;

    startSaveTransition(async () => {
      const result = await hideEvidenceAtomicUpdate(evidence.atomicUpdateId);
      if (result.ok) {
        setState({ status: "loaded", evidence: { ...evidence, hidden: true } });
        toast.success("Atomic update hidden");
      } else {
        toast.error("Could not hide this atomic update");
      }
    });
  }

  function removeEvent(eventId: string, confirmEmptyDeletion: boolean) {
    if (state.status !== "loaded") return;
    const evidence = state.evidence;

    setRemovingId(eventId);
    startLoadTransition(async () => {
      const result = await removeEvidenceEvent(evidence.atomicUpdateId, eventId, confirmEmptyDeletion);
      setRemovingId(null);

      if (result.ok) {
        setRemoveConfirm(null);
        setState({
          status: "loaded",
          evidence: { ...evidence, events: evidence.events.filter((event) => event.id !== eventId) },
        });
        toast.success("Change event removed");
        return;
      }

      if ("needsConfirmation" in result && result.needsConfirmation) {
        setRemoveConfirm({ eventId, emptiedAtomicUpdate: result.emptiedAtomicUpdate });
        return;
      }

      toast.error(result.reason);
    });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger
          render={
            <Button variant="ghost" size="sm">
              Evidence
            </Button>
          }
        />
        <DialogContent className="flex flex-col gap-4 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>The atomic update and change events behind this signal.</DialogDescription>
          </DialogHeader>

          {(state.status === "idle" || state.status === "loading") && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}

          {state.status === "empty" && (
            <p className="text-sm text-muted-foreground">
              No atomic update behind this signal — it may have been deleted.
            </p>
          )}

          {state.status === "loaded" && (
            <div className="flex flex-col gap-3">
              <Input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                aria-label="Title"
                disabled={state.evidence.hidden || savePending}
              />
              <Textarea
                value={draftSummary}
                onChange={(e) => setDraftSummary(e.target.value)}
                aria-label="Summary"
                disabled={state.evidence.hidden || savePending}
              />

              <div className="flex gap-2">
                <Select
                  value={draftSize ?? undefined}
                  onValueChange={(value) => setDraftSize(value as SignalEvidence["size"])}
                  disabled={state.evidence.hidden || savePending}
                >
                  <SelectTrigger className="w-24" aria-label="Size">
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
                  value={draftCategory ?? undefined}
                  onValueChange={(value) => setDraftCategory(value as SignalEvidence["category"])}
                  disabled={state.evidence.hidden || savePending}
                >
                  <SelectTrigger className="w-40" aria-label="Category">
                    <SelectValue placeholder="Category">
                      {(value) => (value ? (CATEGORY_LABEL[value as string] ?? String(value)) : "Category")}
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

              <div className="flex flex-col gap-1.5 border-t pt-2">
                <span className="text-xs font-medium text-muted-foreground">Change events</span>
                {state.evidence.events.length === 0 && (
                  <p className="text-xs text-muted-foreground">No change events.</p>
                )}
                {state.evidence.events.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    removing={removingId === event.id}
                    onRemove={() => removeEvent(event.id, false)}
                  />
                ))}
              </div>
            </div>
          )}

          <DialogFooter showCloseButton>
            {state.status === "loaded" &&
              (state.evidence.hidden ? (
                <Badge variant="outline">Hidden</Badge>
              ) : (
                <>
                  <Button variant="ghost" disabled={savePending} onClick={hide}>
                    {savePending ? "Working…" : "Hide"}
                  </Button>
                  <Button disabled={savePending} onClick={save}>
                    {savePending ? "Saving…" : "Save"}
                  </Button>
                </>
              ))}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeConfirm !== null}
        onOpenChange={(next) => !next && !loadPending && setRemoveConfirm(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete emptied atomic update?</DialogTitle>
            <DialogDescription>
              {removeConfirm && (
                <>
                  Removing this change event will leave &quot;{removeConfirm.emptiedAtomicUpdate.title}&quot; with no
                  change events, so it will be deleted.
                  {removeConfirm.emptiedAtomicUpdate.inDraft
                    ? " It's part of a draft release; deleting it removes a member the draft's body still describes."
                    : null}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" disabled={loadPending} />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={loadPending}
              onClick={() => removeConfirm && removeEvent(removeConfirm.eventId, true)}
            >
              {loadPending ? "Deleting…" : "Delete and remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
