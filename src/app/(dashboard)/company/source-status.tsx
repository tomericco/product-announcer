import type { Source } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { ConnectedIndicator } from "../integrations/connected-indicator";

// Pinned locale + UTC, matching signal-row.tsx's DATE_FORMAT: an unpinned
// toLocaleString() renders differently on the server and the client and
// breaks hydration. Shared by every source-health display on this page —
// competitor sources (competitors-editor.tsx) and the news source
// (news-toggle.tsx) both date-format the same way.
export const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const STATUS_LABEL: Record<Source["status"], string> = {
  active: "Active",
  failing: "Failing",
  disabled: "Disabled",
};

/**
 * The status badge shared by every source-health display on this page.
 * Competitor sources and the news source both carry the same three states
 * (`active` / `failing` / `disabled`), so this is the one treatment for all
 * of them rather than each card inventing its own.
 */
export function SourceStatusBadge({ status }: { status: Source["status"] }) {
  if (status === "active") return <ConnectedIndicator label="Active" />;
  return <Badge variant={status === "failing" ? "destructive" : "outline"}>{STATUS_LABEL[status]}</Badge>;
}
