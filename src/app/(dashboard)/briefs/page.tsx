import { Inbox } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDescription,
} from "@/components/ui/empty-state";
import { db } from "@/db";
import { briefStatusEnum, type Brief, type BriefRun } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listBriefs, latestBriefRun, type BriefFilters } from "@/lib/briefs/query";
import { single } from "@/lib/signals/params";
import { BriefsFilters } from "./briefs-filters";
import { BriefsList } from "./briefs-list";

const STATUS_LABEL: Record<Brief["status"], string> = {
  new: "new",
  accepted: "accepted",
  dismissed: "dismissed",
  expired: "expired",
};

/**
 * An unrecognised `?status=` must fall back to the default rather than reach
 * `listBriefs` — mirrors `parseKind` in `src/lib/signals/params.ts`, just with
 * `briefStatusEnum`'s four members instead of `signalKindEnum`'s.
 */
function parseStatus(value: string | undefined): Brief["status"] | undefined {
  return (briefStatusEnum.enumValues as readonly string[]).includes(value ?? "")
    ? (value as Brief["status"])
    : undefined;
}

/**
 * The header's read of `latestRun` — separate from the empty-state branching
 * below. This line is tenant-wide agent status ("when did it last run, and
 * how"), so it renders whenever a run exists, whether or not the current
 * filter happens to have rows. The three-way distinction the empty state
 * makes is about explaining an empty NEW-briefs queue specifically; this is
 * just "is the agent alive."
 */
function RunStatusLine({ latestRun }: { latestRun: BriefRun | null }) {
  if (!latestRun) return null;

  const when = formatDistanceToNow(latestRun.ranAt, { addSuffix: true });

  if (latestRun.error) {
    return (
      <p className="text-sm text-destructive">
        Last run {when} failed: {latestRun.error}
      </p>
    );
  }

  return (
    <p className="text-sm text-muted-foreground">
      Last run {when}
      {latestRun.assessment ? ` — ${latestRun.assessment}` : ""} ({latestRun.briefsCreated} created,{" "}
      {latestRun.briefsExtended} extended)
    </p>
  );
}

/**
 * The three empty states this page exists to distinguish — see
 * `brief_runs`'s doc comment in `src/db/schema.ts` and `run.ts`'s "worst
 * failure this system has" comment. Only used for the default/`new` queue:
 * an empty `accepted`/`dismissed`/`expired` filter is just "nothing matches
 * this filter", not a statement about whether the agent is working.
 */
function NewQueueEmptyState({ latestRun }: { latestRun: BriefRun | null }) {
  if (latestRun === null) {
    return (
      <EmptyState>
        <EmptyStateIcon>
          <Inbox />
        </EmptyStateIcon>
        <EmptyStateTitle>The agent hasn&apos;t run yet</EmptyStateTitle>
        <EmptyStateDescription>
          It runs daily and will propose briefs here once it finds something worth writing about.
        </EmptyStateDescription>
      </EmptyState>
    );
  }

  if (latestRun.error) {
    return (
      <EmptyState>
        <EmptyStateIcon>
          <Inbox />
        </EmptyStateIcon>
        <EmptyStateTitle>The last run failed</EmptyStateTitle>
        <EmptyStateDescription>{latestRun.error}</EmptyStateDescription>
      </EmptyState>
    );
  }

  return (
    <EmptyState>
      <EmptyStateIcon>
        <Inbox />
      </EmptyStateIcon>
      <EmptyStateTitle>Nothing worth writing, for now</EmptyStateTitle>
      <EmptyStateDescription>
        {latestRun.assessment ?? "The agent ran and found nothing worth turning into a brief."}
      </EmptyStateDescription>
    </EmptyState>
  );
}

/**
 * The brief inbox: the human gate the whole content-hub model rests on. An
 * async Server Component page — in Next.js 16 `searchParams` is a `Promise`
 * and must be awaited (see the comment on `SignalsPage`, which documents the
 * same thing and links the doc). Reading it opts this page into dynamic
 * rendering, which is what's wanted: every request must reflect the latest
 * filter and the latest agent run.
 */
export default async function BriefsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const status = parseStatus(single(params.status));

  const filters: BriefFilters = { status };

  const [briefs, latestRun] = await Promise.all([
    listBriefs(session.user.tenantId, filters, db),
    latestBriefRun(session.user.tenantId, db),
  ]);

  const effectiveStatus = status ?? "new";

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Briefs</h1>
          <Badge variant="secondary">{briefs.length}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Content ideas the agent proposed from what it&apos;s seen — shipped work, competitor moves, and
          market news — waiting on a human decision.
        </p>
      </div>

      <RunStatusLine latestRun={latestRun} />

      <BriefsFilters status={effectiveStatus} />

      {briefs.length === 0 ? (
        effectiveStatus === "new" ? (
          <NewQueueEmptyState latestRun={latestRun} />
        ) : (
          <EmptyState>
            <EmptyStateIcon>
              <Inbox />
            </EmptyStateIcon>
            <EmptyStateTitle>No {STATUS_LABEL[effectiveStatus]} briefs</EmptyStateTitle>
            <EmptyStateDescription>Nothing matches this filter yet.</EmptyStateDescription>
          </EmptyState>
        )
      ) : (
        <BriefsList briefs={briefs} />
      )}
    </div>
  );
}
