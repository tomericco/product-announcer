import { Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDescription,
} from "@/components/ui/empty-state";
import { listAtomicUpdates, listSelectableEvents } from "./actions";
import { AtomicUpdatesList } from "./atomic-updates-list";
import { NewAtomicUpdateDialog } from "./new-atomic-update-dialog";

export default async function AtomicUpdatesPage() {
  // Fetched together: the list of existing (open, unclaimed) atomic updates
  // for the cards, and the events selectable as input for a brand-new one —
  // both tenant-scoped server-side reads, so the modal client component never
  // needs to import `db`.
  const [rows, selectableEvents] = await Promise.all([listAtomicUpdates(), listSelectableEvents()]);

  if (rows.length === 0) {
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
        <NewAtomicUpdateDialog events={selectableEvents} />
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
      <AtomicUpdatesList rows={rows} selectableEvents={selectableEvents} />
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
