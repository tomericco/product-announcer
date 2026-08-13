import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  listAtomicUpdates,
  hasCuratableAtomicUpdates,
  type AtomicUpdateListFilters,
} from "@/lib/atomic-updates/list";
import { listImportRepos } from "@/lib/change-events/list";
import { isNotionConnected } from "../integrations/import-actions";
import { AtomicUpdatesFilters } from "./atomic-updates-filters";
import { AtomicUpdatesList } from "./atomic-updates-list";

const CATEGORY_VALUES = ["new", "improvement", "fix", "announcement"] as const;
const SIZE_VALUES = ["s", "m", "l", "xl"] as const;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseCategory(value: string | undefined): AtomicUpdateListFilters["category"] {
  return (CATEGORY_VALUES as readonly string[]).includes(value ?? "")
    ? (value as AtomicUpdateListFilters["category"])
    : undefined;
}

function parseSize(value: string | undefined): AtomicUpdateListFilters["size"] {
  return (SIZE_VALUES as readonly string[]).includes(value ?? "")
    ? (value as AtomicUpdateListFilters["size"])
    : undefined;
}

/**
 * The Company page's "Atomic updates" section: the all-time ledger, lifted
 * from the standalone /atomic-updates page. Deliberately NOT windowed to
 * `SIGNAL_WINDOW_DAYS` (unlike the /signals feed) — `syncShippedWorkSignals`
 * never created a signal for an atomic update outside that window, so this is
 * the only surface that can still reach one. Creation (the former "New atomic
 * update" trigger) has moved to /integrations along with the rest of the
 * manual import subsystem; this section only curates what already exists.
 *
 * Reads take `tenantId` directly from the caller (`CompanyPage`'s own
 * `requireSession()`) rather than going through the atomic-updates route's
 * "use server" wrappers — safe here because, unlike the old
 * `atomic-updates/page.tsx`, nothing "use client" imports a runtime value
 * FROM this file (the `CategoryBadge`/`SizeBadge`/`CATEGORY_LABEL` that
 * `atomic-update-card.tsx` needs live in the standalone `atomic-update-badges`
 * module instead, specifically so this file's server-only imports never have
 * to cross into a client bundle).
 */
export async function AtomicUpdatesSection({
  tenantId,
  searchParams,
}: {
  tenantId: string;
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const category = parseCategory(single(searchParams.auCategory));
  const size = parseSize(single(searchParams.auSize));
  const showHidden = single(searchParams.auShowHidden) === "1";
  const hasActiveFilter = category !== undefined || size !== undefined || showHidden;

  const [rows, anyCuratable, importRepos, notionConnected] = await Promise.all([
    listAtomicUpdates(tenantId, { category, size, showHidden }),
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
        category={category ?? "all"}
        size={size ?? "all"}
        showHidden={showHidden}
        basePath="/company"
        paramPrefix="au"
      />
      <AtomicUpdatesList rows={rows} repos={importRepos} notionConnected={notionConnected} />
    </div>
  );
}
