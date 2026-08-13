import { Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDescription,
} from "@/components/ui/empty-state";
import { listAtomicUpdates, hasCuratableAtomicUpdates } from "./actions";
import type { AtomicUpdateListFilters } from "@/lib/atomic-updates/list";
import { listImportRepos } from "../change-events/actions";
import { isNotionConnected } from "../change-events/import-actions";
import { AtomicUpdatesList } from "./atomic-updates-list";
import { AtomicUpdatesFilters } from "./atomic-updates-filters";
import { NewAtomicUpdateDialog } from "./new-atomic-update-dialog";

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

export default async function AtomicUpdatesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const category = parseCategory(single(params.category));
  const size = parseSize(single(params.size));
  const showHidden = single(params.showHidden) === "1";
  const hasActiveFilter = category !== undefined || size !== undefined || showHidden;

  // Fetched together: the unclaimed atomic updates for the cards — open ones
  // plus, when "Show hidden" is on, the hidden ones inline among them, all
  // narrowed by the category/size filters — and the events selectable as input
  // for a brand-new update (or as evidence added to an existing one). All
  // tenant-scoped server-side reads, so no client component here ever needs to
  // import `db`.
  const [rows, anyCuratable, importRepos, notionConnected] = await Promise.all([
    listAtomicUpdates({ category, size, showHidden }),
    hasCuratableAtomicUpdates(),
    listImportRepos(),
    isNotionConnected(),
  ]);

  // The onboarding empty state is only for a genuinely empty workspace — never
  // when a filter is simply narrowing the view to nothing (that keeps the
  // header + filter bar so the user can widen it again). `anyCuratable` counts
  // hidden updates too, so a workspace whose updates are all hidden still gets
  // the list page, and with it the "Show hidden" toggle that reaches them.
  if (!anyCuratable && !hasActiveFilter) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <EmptyState>
          <EmptyStateIcon>
            <Layers />
          </EmptyStateIcon>
          <EmptyStateTitle>No atomic updates yet</EmptyStateTitle>
          <EmptyStateDescription>
            They appear here as commits and pull requests are ingested — each one a single
            user-facing change, gathered from the commits, pull requests, and tasks behind it.
          </EmptyStateDescription>
        </EmptyState>
        <NewAtomicUpdateDialog repos={importRepos} notionConnected={notionConnected} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Atomic updates</h1>
            <Badge variant="secondary">{rows.length}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Each one is a single user-facing change, gathered from the commits, pull requests, and
            tasks behind it.
          </p>
        </div>
        <NewAtomicUpdateDialog repos={importRepos} notionConnected={notionConnected} />
      </div>
      <AtomicUpdatesFilters category={category ?? "all"} size={size ?? "all"} showHidden={showHidden} />
      <AtomicUpdatesList rows={rows} repos={importRepos} notionConnected={notionConnected} />
    </div>
  );
}

export const CATEGORY_LABEL: Record<string, string> = {
  new: "New",
  improvement: "Improvement",
  fix: "Fix",
  announcement: "Announcement",
};

export function CategoryBadge({ category }: { category: string | null }) {
  if (!category) return null;
  return <Badge variant="secondary">{CATEGORY_LABEL[category] ?? category}</Badge>;
}

export function SizeBadge({ size }: { size: string | null }) {
  if (!size) return null;
  return <Badge variant="outline">{size.toUpperCase()}</Badge>;
}
