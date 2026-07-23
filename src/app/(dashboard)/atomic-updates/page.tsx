import { Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDescription,
} from "@/components/ui/empty-state";
import { listAtomicUpdates, listHiddenAtomicUpdates } from "./actions";
import { listImportRepos } from "../change-events/actions";
import { AtomicUpdatesList } from "./atomic-updates-list";
import { NewAtomicUpdateDialog } from "./new-atomic-update-dialog";

export default async function AtomicUpdatesPage() {
  // Fetched together: the list of existing (open, unclaimed) atomic updates
  // for the cards, the events selectable as input for a brand-new one (or as
  // evidence added to an existing one), and the hidden (non-user-facing)
  // atomic updates for the "Show hidden" section — all tenant-scoped
  // server-side reads, so no client component here ever needs to import `db`.
  const [rows, hiddenRows, importRepos] = await Promise.all([
    listAtomicUpdates(),
    listHiddenAtomicUpdates(),
    listImportRepos(),
  ]);

  if (rows.length === 0 && hiddenRows.length === 0) {
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
        <NewAtomicUpdateDialog repos={importRepos} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Atomic updates</h1>
      <p className="text-sm text-muted-foreground">
        Each one is a single user-facing change, gathered from the commits, pull requests, and tasks
        behind it.
      </p>
      <AtomicUpdatesList rows={rows} hiddenRows={hiddenRows} repos={importRepos} />
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
