import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tenants, companyProfiles, type Signal } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listSignals } from "@/lib/signals/query";
import { proposeBriefFromSignals, type ProposalInput } from "@/lib/briefs/propose";
import type { RelevanceProfile } from "@/lib/signals/relevance";
import { single } from "@/lib/signals/params";
import { BriefForm } from "./brief-form";

/**
 * Same shape as `loadProfile` in `src/lib/briefs/run.ts` (unexported there,
 * so duplicated rather than reached across a module boundary that has no
 * other reason to be public). `name` comes from the tenant row, not
 * `companyProfiles` — see `RelevanceProfile`'s own doc comment.
 */
async function loadProfile(tenantId: string): Promise<RelevanceProfile> {
  const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId));
  return {
    name: tenant?.name ?? "",
    oneLiner: profile?.oneLiner ?? null,
    positioning: profile?.positioning ?? null,
    topics: profile?.topics ?? [],
  };
}

function parseSignalIds(raw: string | undefined): string[] {
  if (!raw) return [];
  // De-duplicated, order preserved — the order the human selected them in on
  // /signals, which `URLSearchParams`/`Set` both keep as insertion order.
  return [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
}

/**
 * `/briefs/new`: proposes a brief from signals a human already selected, then
 * lets them edit and save it — the manual-creation path the design doc closes
 * with (`docs/superpowers/specs/2026-08-06-manual-brief-creation-design.md`).
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
 * `chosen` is passed to `BriefForm` as the evidence to attach either way —
 * whether or not the proposal below succeeds. Per the design doc ("Opens
 * pre-filled from the proposal... and saves a brief row with... the selected
 * signals attached"), the human's selection is not the model's to revise, so
 * a failed proposal still keeps the evidence and blanks only the prose
 * fields the model would have written.
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
  const chosen: Signal[] = requestedIds
    .map((id) => byId.get(id))
    .filter((s): s is Signal => s !== undefined);

  // No signals resolved (none requested, or none survived tenant/window
  // scoping) means nothing to propose from — `proposeBriefFromSignals`
  // itself would just return its own "select at least one signal" error, so
  // skipping the call avoids a needless model round-trip and, per the
  // degradation rule this feature exists for, never blocks the form.
  const proposal =
    chosen.length > 0
      ? await proposeBriefFromSignals({
          signals: chosen.map(
            (s): ProposalInput => ({
              id: s.id,
              kind: s.kind,
              title: s.title,
              excerpt: s.excerpt,
              occurredAt: s.occurredAt,
            })
          ),
          profile: await loadProfile(tenantId),
          tenantId,
        })
      : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">New brief</h1>
        <p className="text-sm text-muted-foreground">
          {chosen.length > 0
            ? "Proposed from the signals you selected — edit anything before saving."
            : "Write a brief by hand and it lands in the inbox like any other."}
        </p>
      </div>

      <BriefForm
        proposal={proposal && proposal.ok ? proposal.brief : null}
        proposalError={proposal && !proposal.ok ? proposal.error : null}
        evidence={chosen.map((s) => ({ id: s.id, title: s.title, kind: s.kind }))}
      />
    </div>
  );
}
