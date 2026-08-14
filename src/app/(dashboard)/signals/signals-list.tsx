"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { groupByMonth } from "@/lib/group-by-month";
import { retainVisible } from "@/lib/signals/selection";
import type { Signal } from "@/db/schema";
import { SignalRow } from "./signal-row";
import { CreateBriefModal } from "./create-brief-modal";

/**
 * The signals browser's list, plus selection (spec 6: turning a chosen set
 * into a brief). Rows are grouped by the month they *occurred* in, newest
 * first — `occurredAt` is the "when did this happen" question a debugging
 * view is worth grouping by, distinct from `createdAt`'s "how long do we
 * keep it" that `listSignals`'s 60-day window already enforces upstream of
 * this component ever seeing a row.
 *
 * `rows` already arrives newest-occurredAt-first from `listSignals`, so this
 * only adds the month headings — it never reorders rows within a month.
 *
 * A client component because selection is pure client UI state (`Set<string>`
 * of ids) — the page itself stays a Server Component and only ever passes
 * plain props down, keeping `db`/pg out of this bundle.
 *
 * `maxSelectable` arrives as a prop rather than being imported here as
 * `MAX_PROPOSAL_SIGNALS` from `@/lib/briefs/propose`: that module pulls in
 * the AI SDK and the model resolver, and importing a runtime value from it
 * into a `"use client"` file would drag all of that into the browser bundle —
 * the exact bug this project shipped and caught days ago. The page (a Server
 * Component) reads the real constant and hands down only the number.
 */
export function SignalsList({
  rows,
  competitorsById,
  maxSelectable,
}: {
  rows: Signal[];
  competitorsById: Map<string, string>;
  maxSelectable: number;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Filters navigate via `router.push` — a soft navigation — so this
  // component is never remounted when `rows` narrows; without this,
  // `selected` would keep ids that scrolled out of the current filter,
  // still eating a cap slot and still riding along into the brief "Create
  // brief" commissions, with no row left on screen to show or deselect
  // them. See
  // `retainVisible`'s own comment for the full reasoning. Skips the
  // `setSelected` call when nothing was dropped, so an unrelated re-render
  // that hands down a new-but-equivalent `rows` array doesn't churn state.
  useEffect(() => {
    // `selected` is state React owns, but `rows` is an external input (the
    // server-rendered filter result) this effect must stay synchronized
    // against — the standard, intentional shape the newer react-hooks lint
    // rule flags as "setState synchronously in an effect". There's no
    // subscribe-to-an-external-system alternative here: `rows` simply
    // changes identity on every filter navigation, and reconciling in the
    // render body itself would still need this same call to actually drop
    // the state (a derived value alone wouldn't stop stale ids from being
    // added right back to by a stale `toggle` closure).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected((prev) => {
      const next = retainVisible(prev, rows);
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < maxSelectable) {
        next.add(id);
      }
      return next;
    });
  }

  const atCap = selected.size >= maxSelectable;

  // Never selectable: a stale `shipped_work` signal is work that was
  // withdrawn, and commissioning a brief about something that no longer
  // ships is the same failure `listSignals` already filters for elsewhere.
  // Beyond the cap: the proposal prompt (`proposeBriefFromSignals`) stops
  // being bounded past `maxSelectable` signals, so once it's reached, only
  // already-selected rows stay interactive (to deselect) — everything else
  // is disabled with a reason rather than silently doing nothing on click.
  function disabledReason(row: Signal): string | null {
    if (row.status === "stale") return "Stale signals can't be turned into a brief.";
    if (atCap && !selected.has(row.id)) return `Selection is capped at ${maxSelectable} signals.`;
    return null;
  }

  const monthGroups = groupByMonth(rows, (row) => row.occurredAt);
  const selectedIds = [...selected];

  return (
    <div className="space-y-3">
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 p-3">
          <span className="text-sm font-medium">
            {selectedIds.length} of {maxSelectable} selected
          </span>
          {atCap && <span className="text-xs text-muted-foreground">Maximum reached — deselect one to add another.</span>}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            {/* Was a Link to /briefs/new?signals=… , whose server render
                awaited a model call to pre-fill the form — a frozen
                navigation with no feedback. The modal creates the brief in
                place and reports the wait (spec B).

                The selection is dropped once a brief has been made from it.
                The old flow navigated away to `/briefs/new`, which unmounted
                this component and cleared it; the modal returns here with
                every row still ticked and the same button still live, so
                clicking again would commission a second brief from the same
                evidence. `onBriefCreated` fires when the modal is finished
                showing the result, not the instant the row exists — clearing
                sooner would unmount the modal out from under the user (this
                bar only renders while something is selected). */}
            <CreateBriefModal signalIds={selectedIds} onBriefCreated={() => setSelected(new Set())} />
          </div>
        </div>
      )}

      {monthGroups.map((group) => (
        <section key={group.key} className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">{group.label}</h2>
          <ul className="flex flex-col gap-3">
            {group.items.map((row) => (
              <li key={row.id}>
                <SignalRow
                  row={row}
                  competitorName={row.competitorId ? competitorsById.get(row.competitorId) : undefined}
                  selected={selected.has(row.id)}
                  onToggleSelected={() => toggle(row.id)}
                  selectionDisabled={disabledReason(row)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
