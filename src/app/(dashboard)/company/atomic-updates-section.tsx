import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { listAtomicUpdates, hasCuratableAtomicUpdates } from "@/lib/atomic-updates/list";
import { listImportRepos } from "@/lib/change-events/list";
import { isNotionConnected } from "../integrations/import-actions";
import { AtomicUpdatesFilters } from "./atomic-updates-filters";
import { AtomicUpdatesList } from "./atomic-updates-list";
import {
  atomicUpdatesFiltersAreDefault,
  readAtomicUpdatesFilters,
  type SearchParamsRecord,
} from "./filter-params";

/**
 * The Company page's "Atomic updates" section: the all-time ledger, lifted
 * from the standalone /atomic-updates page. Deliberately NOT windowed to
 * `SIGNAL_WINDOW_DAYS` (unlike the /signals feed) — `syncShippedWorkSignals`
 * never created a signal for an atomic update outside that window, so this is
 * the only surface that can still reach one. Creation (the former "New atomic
 * update" trigger) has moved to /integrations along with the rest of the
 * manual import subsystem; this section only curates what already exists.
 *
 * "Show hidden" is load-bearing, not a nicety: `listAtomicUpdates` returns
 * only `status='open'` without it, so this filter is the ONLY way to list a
 * hidden atomic update anywhere in the product — and therefore the only entry
 * point to Unhide. The drawer on /signals can hide, and hiding also marks the
 * signal stale so the row leaves the feed.
 *
 * Reads take `tenantId` directly from the caller (`CompanyPage`'s own
 * `requireSession()`) rather than going through a "use server" wrapper — safe
 * here because nothing "use client" imports a runtime value FROM this file
 * (the `CategoryBadge`/`SizeBadge`/`CATEGORY_LABEL` that `atomic-update-card.tsx`
 * needs live in the standalone `atomic-update-badges` module instead,
 * specifically so this file's server-only imports never have to cross into a
 * client bundle).
 */
export async function AtomicUpdatesSection({
  tenantId,
  searchParams,
}: {
  tenantId: string;
  searchParams: SearchParamsRecord;
}) {
  const state = readAtomicUpdatesFilters(searchParams);
  const hasActiveFilter = !atomicUpdatesFiltersAreDefault(state);

  const [rows, anyCuratable, importRepos, notionConnected] = await Promise.all([
    listAtomicUpdates(tenantId, {
      category: state.category === "all" ? undefined : state.category,
      size: state.size === "all" ? undefined : state.size,
      showHidden: state.showHidden,
    }),
    hasCuratableAtomicUpdates(tenantId),
    listImportRepos(tenantId),
    isNotionConnected(),
  ]);

  // A genuinely empty workspace — never shown just because a filter narrowed
  // the view to nothing (that keeps the filter bar so it can be widened
  // again). Creation lives on /integrations now, so this points there instead
  // of hosting its own "New atomic update" trigger.
  if (!anyCuratable && !hasActiveFilter) {
    return (
      <p className="text-sm text-muted-foreground">
        No atomic updates yet. They appear here as commits, pull requests, and tasks are imported from{" "}
        <Link href="/integrations" className="underline underline-offset-2 hover:text-foreground">
          Integrations
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-muted-foreground">All time</span>
        <Badge variant="secondary">{rows.length}</Badge>
      </div>
      <AtomicUpdatesFilters
        category={state.category}
        size={state.size}
        showHidden={state.showHidden}
        basePath="/company"
      />
      <AtomicUpdatesList rows={rows} repos={importRepos} notionConnected={notionConnected} />
    </div>
  );
}
