"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowRightLeft, Ban, Split } from "lucide-react";
// A client-safe module by construction — its only import is the `Badge`
// primitive, precisely so a "use client" file can pull a value from it.
import { CATEGORY_LABEL } from "../company/atomic-update-badges";
// Type-only. `@/lib/signals/evidence` has a top-level `db` import (it's
// `readSignalEvidence`'s home) — Next does not tree-shake an unused runtime
// import out of a client bundle, so pulling any *value* export from that
// module in here would drag `pg` into the browser. `import type` erases
// entirely at compile time. The actual data comes from `loadSignalEvidence`,
// a "use server" action below — a Server Function reference, not a runtime
// value out of a server module.
import type { SignalEvidence, EvidenceEvent } from "@/lib/signals/evidence";
// Type-only, same reasoning: `@/lib/change-events/reassign` also has a
// top-level `db` import.
import type { ReassignResult } from "@/lib/change-events/reassign";
// A VALUE import, and safe: `save-outcome` is a pure module with no `db` (or
// React) import of its own, kept that way precisely so both this drawer and
// the curation card on /company can derive one Save outcome the same way.
import { saveOutcomeMessage, type SavePart } from "@/lib/atomic-updates/save-outcome";
import {
  loadSignalEvidence,
  loadEvidenceReassignTargets,
  saveEvidenceEdit,
  saveEvidenceSize,
  saveEvidenceCategory,
  hideEvidenceAtomicUpdate,
  reassignEvidenceEvent,
  removeEvidenceEvent,
} from "./evidence-actions";

const SIZE_OPTIONS: Array<NonNullable<SignalEvidence["size"]>> = ["s", "m", "l", "xl"];

const CATEGORY_OPTIONS: Array<NonNullable<SignalEvidence["category"]>> = [
  "new",
  "improvement",
  "fix",
  "announcement",
];

export type EmptiedAtomicUpdate = { id: string; title: string; inDraft: boolean };

/** One of the drawer's reassign destinations (`openAtomicUpdatesForReassign`). */
export type EvidenceReassignTarget = { id: string; title: string };

/**
 * What a per-event control does. Both outcomes look the same to the drawer —
 * the event leaves THIS atomic update's evidence list either way — but they
 * are different core calls: "remove" detaches with `forceRegenerate`, while
 * "reassign" moves the event onto another open update (or splits it into a
 * new one) and leaves a hand-edited summary frozen.
 */
export type EventMutation =
  | { kind: "remove" }
  | { kind: "reassign"; target: { kind: "existing"; atomicUpdateId: string } | { kind: "new" } };

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
 * from another drawer, or the Company page, in between opens should be
 * visible rather than showing a stale snapshot from the first open.
 */
export function shouldFetchOnOpen(open: boolean, state: EvidenceLoadState): boolean {
  return open && state.status === "idle";
}

/**
 * The request-generation guard. Every async path (load, save, hide, remove)
 * captures `requestTokenRef.current` as `requestToken` right before firing;
 * the ref is bumped both whenever a NEW request starts and whenever the
 * dialog closes. A response is safe to apply only if its captured token still
 * equals the ref's current value — i.e. nothing newer has started and the
 * dialog hasn't been closed since.
 *
 * Without this, a request left in flight when the drawer closes resolves
 * into a component that has already reset to `"idle"`: the callback would
 * silently overwrite that reset (suppressing the documented "always fetch
 * fresh on reopen" behaviour) and, worse, a stale `save` resolving after a
 * reopen-and-re-edit would clobber the freshly loaded evidence with the
 * closed session's stale draft values.
 */
export function shouldApplyResponse(requestToken: number, currentToken: number): boolean {
  return requestToken === currentToken;
}

/**
 * The editable draft fields seeded from a freshly loaded atomic update.
 * Extracted so the seeding itself — which fields come from where — is
 * testable without jsdom, independent of when/how the component decides to
 * call it.
 */
export type EvidenceDrafts = {
  title: string;
  summary: string;
  size: SignalEvidence["size"];
  category: SignalEvidence["category"];
};

export function draftsFromEvidence(evidence: SignalEvidence): EvidenceDrafts {
  return {
    title: evidence.title,
    summary: evidence.summary,
    size: evidence.size,
    category: evidence.category,
  };
}

/**
 * What a per-event mutation (remove OR reassign) should do with its
 * `ReassignResult`, extracted out of the component so the three-way fork —
 * success, needs-confirmation, rejection — is directly testable. The core's
 * `needsConfirmation` branch doesn't carry the `eventId` that triggered it
 * (only the atomic update it would empty), so this takes it as a separate
 * argument and folds it into the outcome for the caller, which has to re-post
 * the same mutation for that same event once confirmed.
 */
export type EventMutationOutcome =
  | { kind: "applied" }
  | { kind: "needs_confirmation"; eventId: string; emptiedAtomicUpdate: EmptiedAtomicUpdate }
  | { kind: "rejected"; reason: string };

export function classifyEventMutationResult(result: ReassignResult, eventId: string): EventMutationOutcome {
  if (result.ok) return { kind: "applied" };
  if ("needsConfirmation" in result && result.needsConfirmation) {
    return { kind: "needs_confirmation", eventId, emptiedAtomicUpdate: result.emptiedAtomicUpdate };
  }
  return { kind: "rejected", reason: result.reason };
}

/**
 * The evidence a successful Hide leaves behind.
 *
 * `hidden` and `editable` must move together: hiding sets `status='hidden'`,
 * and every curation write behind this drawer is guarded on `status='open'`,
 * so a hidden update is no longer editable. Extracted because getting that
 * wrong is invisible in the drawer's own code — when the read-only gates moved
 * from `hidden` to `!editable`, `hide()` kept setting only `hidden: true`, so
 * a just-hidden update went on rendering enabled inputs and a Hide/Save
 * footer, both of which the server then refused.
 */
export function evidenceAfterHide(evidence: SignalEvidence): SignalEvidence {
  return { ...evidence, hidden: true, editable: false };
}

/** The success toast for a mutation, so the wording is testable too. */
export function eventMutationSuccessMessage(mutation: EventMutation): string {
  if (mutation.kind === "remove") return "Change event removed";
  return mutation.target.kind === "new" ? "Split into a new atomic update" : "Change event reassigned";
}

/**
 * One change event: its label (linked to the provider when there's a url),
 * plus the two per-event actions the design calls for — reassign (move to
 * another open atomic update, or split into a new one) and remove from this
 * update. Reassign is the one that was missing: without it, moving an event
 * between two atomic updates meant remove → /company → "Show hidden" →
 * reassign, and the remove leg additionally forced a regeneration of the
 * source update's summary on the way past.
 */
function EventRow({
  event,
  targets,
  onReassign,
  onRemove,
  disabled,
  pending,
}: {
  event: EvidenceEvent;
  targets: EvidenceReassignTarget[];
  onReassign: (target: { kind: "existing"; atomicUpdateId: string } | { kind: "new" }) => void;
  onRemove: () => void;
  disabled: boolean;
  pending: boolean;
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
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" disabled={disabled || pending} />}>
          {pending ? "Working…" : "Reassign"}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {targets.length > 0 && (
            <>
              {/* `DropdownMenuLabel` is Base UI's `Menu.GroupLabel`, which
                  throws ("MenuGroupContext is missing") the moment the popup
                  renders unless it sits inside a `Menu.Group` — so the label
                  and the items it labels are wrapped together. */}
              <DropdownMenuGroup>
                <DropdownMenuLabel>Move to</DropdownMenuLabel>
                {targets.map((target) => (
                  <DropdownMenuItem
                    key={target.id}
                    onClick={() => onReassign({ kind: "existing", atomicUpdateId: target.id })}
                  >
                    <ArrowRightLeft />
                    <span className="truncate">{target.title}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={() => onReassign({ kind: "new" })}>
            <Split />
            Split to new
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onRemove}>
            <Ban />
            Remove from this update
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The evidence drawer behind a `shipped_work` signal: the atomic update it
 * mirrors, plus the change events behind that update, with the curation
 * actions the retired Atomic updates tab used to offer — edit title/summary,
 * set size/category, hide, and per change event reassign or remove.
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
  const [targets, setTargets] = useState<EvidenceReassignTarget[]>([]);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [mutationConfirm, setMutationConfirm] = useState<{
    eventId: string;
    mutation: EventMutation;
    emptiedAtomicUpdate: EmptiedAtomicUpdate;
  } | null>(null);

  const [draftTitle, setDraftTitle] = useState("");
  const [draftSummary, setDraftSummary] = useState("");
  const [draftSize, setDraftSize] = useState<SignalEvidence["size"]>(null);
  const [draftCategory, setDraftCategory] = useState<SignalEvidence["category"]>(null);

  // The request-generation token (see `shouldApplyResponse`'s docstring).
  // Bumped whenever a new request starts (invalidating whatever was already
  // in flight) and whenever the dialog closes or the drawer unmounts
  // (invalidating anything in flight with nothing new to replace it). A ref,
  // not state: it never needs to trigger a render on its own — it only gates
  // what an already-scheduled render does.
  const requestTokenRef = useRef(0);

  // Belt-and-suspenders alongside the close-time bump in `handleOpenChange`:
  // a drawer can also leave the tree without an explicit close (e.g. its row
  // scrolls out via a filter change that unmounts the list). Nothing here
  // calls setState — only a ref mutation — so this isn't the
  // set-state-in-effect pattern the lint rule flags.
  useEffect(() => {
    return () => {
      requestTokenRef.current += 1;
    };
  }, []);

  // Seeds the draft fields the moment a fresh load lands — set here, at the
  // point the new "loaded" state is computed, rather than in an effect keyed
  // on `state`: setting state synchronously inside an effect body is exactly
  // the cascading-render pattern the react-hooks lint rule (and React's own
  // docs) warn against, and there's no external system to synchronize with
  // here, just local state that changes together.
  function handleOpenChange(next: boolean) {
    if (shouldFetchOnOpen(next, state)) {
      const requestToken = ++requestTokenRef.current;
      setState({ status: "loading" });
      startLoadTransition(async () => {
        // The reassign targets are fetched with the evidence, not ahead of it:
        // like the evidence itself, most signal rows are never expanded, so
        // the list page must not pay for either.
        const [result, reassignTargets] = await Promise.all([
          loadSignalEvidence(signalId),
          loadEvidenceReassignTargets(),
        ]);
        if (!shouldApplyResponse(requestToken, requestTokenRef.current)) return;

        const nextState = loadStateFromResult(result);
        setState(nextState);
        setTargets(reassignTargets);
        if (nextState.status === "loaded") {
          const drafts = draftsFromEvidence(nextState.evidence);
          setDraftTitle(drafts.title);
          setDraftSummary(drafts.summary);
          setDraftSize(drafts.size);
          setDraftCategory(drafts.category);
        }
      });
    }
    if (!next) {
      // Invalidates any request still in flight from this open (a load that
      // hasn't resolved, or a save/hide/remove issued just before closing) —
      // its resolution will find a mismatched token and skip touching state,
      // so the reset to "idle" below sticks, and the next open reliably
      // fetches fresh instead of being silently overwritten later.
      requestTokenRef.current += 1;
      setState({ status: "idle" });
      setMutationConfirm(null);
    }
    setOpen(next);
  }

  function save() {
    if (state.status !== "loaded") return;
    const evidence = state.evidence;
    const requestToken = ++requestTokenRef.current;

    startSaveTransition(async () => {
      try {
        // All three writes carry the same `status='open'` guard, so a refused
        // edit means the size/category calls would be refused too — bail
        // instead of reporting a half-applied save (the shape this used to
        // have: the title silently written while size/category toasted a
        // failure).
        const edited = await saveEvidenceEdit(evidence.atomicUpdateId, {
          title: draftTitle,
          summary: draftSummary,
        });
        if (!edited.ok) {
          if (!shouldApplyResponse(requestToken, requestTokenRef.current)) return;
          toast.error("Could not save this atomic update");
          return;
        }

        // A size/category call can still come back `{ok:false}` for a reason
        // that isn't the shared guard (a concurrent hide, a deleted row), so
        // the failures are collected rather than toasted as they happen — one
        // Save, one outcome. Reporting each failure inline and then a blanket
        // "Saved" produced two contradictory toasts for a single click.
        const failedParts: SavePart[] = [];
        let savedSize = evidence.size;
        let savedCategory = evidence.category;

        if (draftSize && draftSize !== evidence.size) {
          const result = await saveEvidenceSize(evidence.atomicUpdateId, draftSize);
          if (result.ok) savedSize = draftSize;
          else failedParts.push("size");
        } else {
          savedSize = draftSize ?? evidence.size;
        }
        if (draftCategory && draftCategory !== evidence.category) {
          const result = await saveEvidenceCategory(evidence.atomicUpdateId, draftCategory);
          if (result.ok) savedCategory = draftCategory;
          else failedParts.push("category");
        } else {
          savedCategory = draftCategory ?? evidence.category;
        }

        if (!shouldApplyResponse(requestToken, requestTokenRef.current)) return;

        // Reflects the edit in the drawer's own state immediately — the
        // signal row this drawer hangs off never re-fetches (see the
        // docstring above), so this local update is the only thing that
        // makes the save visible before the next page load. Only the parts
        // that actually persisted are applied, so a failed size doesn't leave
        // the drawer displaying a value the database never took.
        setState({
          status: "loaded",
          evidence: {
            ...evidence,
            title: draftTitle,
            summary: draftSummary,
            size: savedSize,
            category: savedCategory,
          },
        });
        const outcome = saveOutcomeMessage(failedParts);
        if (outcome.ok) toast.success(outcome.message);
        else toast.error(outcome.message);
      } catch (error) {
        if (!shouldApplyResponse(requestToken, requestTokenRef.current)) return;
        toast.error(error instanceof Error ? error.message : "Something went wrong");
      }
    });
  }

  function hide() {
    if (state.status !== "loaded") return;
    const evidence = state.evidence;
    const requestToken = ++requestTokenRef.current;

    startSaveTransition(async () => {
      const result = await hideEvidenceAtomicUpdate(evidence.atomicUpdateId);
      if (!shouldApplyResponse(requestToken, requestTokenRef.current)) return;

      if (result.ok) {
        setState({ status: "loaded", evidence: evidenceAfterHide(evidence) });
        toast.success("Atomic update hidden");
      } else {
        toast.error("Could not hide this atomic update");
      }
    });
  }

  /**
   * The one path behind both per-event controls. Either way the event leaves
   * this atomic update's evidence list, so the local state update and the
   * empty-source confirmation are shared; only the action called and the
   * success wording differ.
   */
  function mutateEvent(eventId: string, mutation: EventMutation, confirmEmptyDeletion: boolean) {
    if (state.status !== "loaded") return;
    const evidence = state.evidence;
    const requestToken = ++requestTokenRef.current;

    setMutatingId(eventId);
    startLoadTransition(async () => {
      const result =
        mutation.kind === "remove"
          ? await removeEvidenceEvent(evidence.atomicUpdateId, eventId, confirmEmptyDeletion)
          : await reassignEvidenceEvent(eventId, mutation.target, confirmEmptyDeletion);
      // Always cleared, even for a stale response: this only clears THIS
      // click's own spinner, not the shared `state` the guard below protects
      // — left set, it would show "Working…" forever on a row whose mutation
      // actually failed after the drawer had already moved on.
      setMutatingId(null);
      if (!shouldApplyResponse(requestToken, requestTokenRef.current)) return;

      const outcome = classifyEventMutationResult(result, eventId);
      switch (outcome.kind) {
        case "applied":
          setMutationConfirm(null);
          setState({
            status: "loaded",
            evidence: { ...evidence, events: evidence.events.filter((event) => event.id !== eventId) },
          });
          toast.success(eventMutationSuccessMessage(mutation));
          break;
        case "needs_confirmation":
          setMutationConfirm({
            eventId: outcome.eventId,
            mutation,
            emptiedAtomicUpdate: outcome.emptiedAtomicUpdate,
          });
          break;
        case "rejected":
          toast.error(outcome.reason);
          break;
      }
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
        <DialogContent className="flex flex-col gap-4 sm:max-w-4xl">
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
              {/* `editable` is `status === 'open'`. The drawer opens on rows
                  the curation list excludes — `syncShippedWorkSignals` leaves
                  a signal behind for a released atomic update — and every
                  curation mutation behind these controls is guarded on that
                  status, so a released (or hidden) update renders read-only
                  rather than offering a Save that would be silently refused. */}
              <Input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                aria-label="Title"
                disabled={!state.evidence.editable || savePending}
              />
              <Textarea
                value={draftSummary}
                onChange={(e) => setDraftSummary(e.target.value)}
                aria-label="Summary"
                disabled={!state.evidence.editable || savePending}
              />

              <div className="flex gap-2">
                <Select
                  value={draftSize ?? undefined}
                  onValueChange={(value) => setDraftSize(value as SignalEvidence["size"])}
                  disabled={!state.evidence.editable || savePending}
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
                  disabled={!state.evidence.editable || savePending}
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
                    // The event's CURRENT update is this drawer's own, so it
                    // is never a useful destination.
                    targets={targets.filter((target) => target.id !== state.evidence.atomicUpdateId)}
                    pending={mutatingId === event.id}
                    disabled={!state.evidence.editable}
                    onReassign={(target) => mutateEvent(event.id, { kind: "reassign", target }, false)}
                    onRemove={() => mutateEvent(event.id, { kind: "remove" }, false)}
                  />
                ))}
              </div>
            </div>
          )}

          <DialogFooter showCloseButton>
            {state.status === "loaded" &&
              (!state.evidence.editable ? (
                <Badge variant="outline">{state.evidence.hidden ? "Hidden" : "Released"}</Badge>
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
        open={mutationConfirm !== null}
        onOpenChange={(next) => !next && !loadPending && setMutationConfirm(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete emptied atomic update?</DialogTitle>
            <DialogDescription>
              {mutationConfirm && (
                <>
                  {mutationConfirm.mutation.kind === "remove" ? "Removing" : "Moving"} this change event will leave
                  &quot;{mutationConfirm.emptiedAtomicUpdate.title}&quot; with no change events, so it will be
                  deleted.
                  {mutationConfirm.emptiedAtomicUpdate.inDraft
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
              onClick={() =>
                mutationConfirm &&
                mutateEvent(mutationConfirm.eventId, mutationConfirm.mutation, true)
              }
            >
              {loadPending ? "Deleting…" : "Delete and continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
