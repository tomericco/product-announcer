import type { Signal } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listSignals } from "@/lib/signals/query";
import { MAX_PROPOSAL_SIGNALS } from "@/lib/briefs/propose";
import { single } from "@/lib/signals/params";
import { BriefForm } from "./brief-form";

function parseSignalIds(raw: string | undefined): string[] {
  if (!raw) return [];
  // De-duplicated, order preserved — the order the human selected them in on
  // /signals, which `URLSearchParams`/`Set` both keep as insertion order.
  return [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
}

/**
 * `/briefs/new`: the hand-written brief path — write a brief from scratch, or
 * from evidence selected on `/signals`, and save it through
 * `createManualBrief`, a plain insert with no model call of its own.
 *
 * Until spec B
 * (`docs/superpowers/specs/2026-08-14-brief-creation-modal-design.md`), a
 * `?signals=` visit also drove an in-render `proposeBriefFromSignals` call
 * here that pre-filled the form — a frozen navigation with no feedback for
 * as long as one model call took. A modal on `/signals` now owns that path
 * end-to-end: it proposes and creates the brief itself and lands on
 * `/briefs/[briefId]`. This route is what the modal's failure branch falls
 * back to — its `Write it by hand` link carries the same `?signals=` ids
 * here, so a proposal that couldn't be made still doesn't cost the human
 * their selection: those ids still resolve and pre-select that evidence
 * below, they just no longer trigger a model call.
 *
 * An async Server Component. `searchParams` is a Promise in Next.js 16 and
 * must be awaited — see the comment on `SignalsPage`
 * (`src/app/(dashboard)/signals/page.tsx`), which documents and links the
 * underlying Next.js doc; this page copies that pattern.
 *
 * The ids in `?signals=` come from a URL and are user-supplied.
 * `listSignals` is what makes reading them "scoped to the session's tenant"
 * true: it already filters on `eq(signals.tenantId, tenantId)` (plus the
 * 60-day window and non-stale rows) before this page ever sees a row, so an
 * id belonging to another tenant — or one that has aged out or gone stale —
 * simply never appears in `allSignals` and silently drops out of `chosen`
 * below. Nothing here trusts the URL directly.
 *
 * `chosen` is passed to `BriefForm` as the evidence to attach on save.
 */
export default async function NewBriefPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const requestedIds = parseSignalIds(single(params.signals));

  const session = await requireSession();
  const tenantId = session.user.tenantId;

  const allSignals = requestedIds.length > 0 ? await listSignals(tenantId, {}) : [];
  const byId = new Map(allSignals.map((s) => [s.id, s]));
  const resolved: Signal[] = requestedIds
    .map((id) => byId.get(id))
    .filter((s): s is Signal => s !== undefined);

  // No model call happens on this route, but a brief still shouldn't carry
  // more evidence than `/signals` itself ever lets a human select at once —
  // this caps a hand-edited `?signals=` URL at the same ceiling the client
  // enforces, rather than letting it attach an unbounded selection.
  const chosen = resolved.slice(0, MAX_PROPOSAL_SIGNALS);
  const droppedOverCap = resolved.length - chosen.length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">New brief</h1>
        <p className="text-sm text-muted-foreground">
          {chosen.length > 0
            ? "Write it yourself — the signals you selected are attached as evidence."
            : "Write a brief by hand and it lands on the board's Brief column like any other."}
        </p>
      </div>

      {droppedOverCap > 0 && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          Only the first {MAX_PROPOSAL_SIGNALS} of {resolved.length} selected signals are used per brief —{" "}
          {droppedOverCap} more {droppedOverCap === 1 ? "was" : "were"} left out.
        </div>
      )}

      <BriefForm evidence={chosen.map((s) => ({ id: s.id, title: s.title, kind: s.kind }))} />
    </div>
  );
}
