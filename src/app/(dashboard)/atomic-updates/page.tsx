import { Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDescription,
  EmptyStateActions,
} from "@/components/ui/empty-state";
import { listAtomicUpdates, listImportRepos } from "./actions";
import { AtomicUpdatesList } from "./atomic-updates-list";
import { ImportCommitsDialog } from "./import-commits-dialog";

export default async function AtomicUpdatesPage() {
  const [rows, importRepos] = await Promise.all([listAtomicUpdates(), listImportRepos()]);

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState>
          <EmptyStateIcon>
            <Layers />
          </EmptyStateIcon>
          <EmptyStateTitle>No atomic updates yet</EmptyStateTitle>
          <EmptyStateDescription>
            They appear here as commits and pull requests are ingested — each one a single
            user-facing change, gathered from the commits, pull requests, and tasks behind it.
          </EmptyStateDescription>
          <EmptyStateActions>
            <ImportCommitsDialog repos={importRepos} />
          </EmptyStateActions>
        </EmptyState>
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
      <AtomicUpdatesList rows={rows} repos={importRepos} />
    </div>
  );
}

export const CATEGORY_LABEL: Record<string, string> = {
  new: "New",
  improved: "Improved",
  fixed: "Fixed",
};

export function CategoryBadge({ category }: { category: string | null }) {
  if (!category) return null;
  return <Badge variant="secondary">{CATEGORY_LABEL[category] ?? category}</Badge>;
}
