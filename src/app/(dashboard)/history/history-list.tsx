"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { getReleaseDetail, type ReleaseDetail } from "./actions";
import { formatShortDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDescription,
} from "@/components/ui/empty-state";

export type HistoryRow = {
  id: string;
  title: string;
  publishedAt: string | null; // ISO
  delivered: string[]; // labels of successful destinations
};

export function HistoryList({ rows }: { rows: HistoryRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReleaseDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Only destinations the release actually published to successfully — a
  // failed/pending attempt is not a place it was delivered.
  const deliveredLabels = detail
    ? detail.destinations
        .filter((d) => d.status === "success")
        .map((d) => d.label)
        .sort()
    : [];

  async function open(id: string) {
    setOpenId(id);
    setDetail(null);
    setError(false);
    setLoading(true);
    try {
      const d = await getReleaseDetail(id);
      if (d) setDetail(d);
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  if (rows.length === 0) {
    return (
      <EmptyState>
        <EmptyStateIcon>
          <History />
        </EmptyStateIcon>
        <EmptyStateTitle>No announcements sent yet</EmptyStateTitle>
        <EmptyStateDescription>
          Releases appear here once you publish a draft to your destinations.
        </EmptyStateDescription>
      </EmptyState>
    );
  }

  return (
    <>
      {/* Negative margin lets the hover highlight breathe past the text column,
          matching the drafts list. */}
      <div className="-mx-3">
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => open(r.id)}
            className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
          >
            <span className="min-w-0 flex-1 truncate font-medium">{r.title}</span>
            <span className="shrink-0 truncate text-sm text-muted-foreground">
              {r.delivered.length > 0 ? r.delivered.slice().sort().join(", ") : "—"}
            </span>
            <span className="shrink-0 text-sm text-muted-foreground">
              {r.publishedAt ? formatShortDate(new Date(r.publishedAt)) : ""}
            </span>
          </button>
        ))}
      </div>

      <Dialog open={openId !== null} onOpenChange={(next) => !next && setOpenId(null)}>
        <DialogContent className="flex max-h-[85dvh] flex-col gap-4 p-6 sm:max-w-2xl">
          {/* Kept mounted (visually hidden) so the dialog always has an
              accessible name; the visible title lives with the body below,
              matching the draft view. */}
          <DialogTitle className="sr-only">{detail ? detail.title : "Release detail"}</DialogTitle>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : error || !detail ? (
            <p className="text-sm text-destructive">Couldn&apos;t load this release.</p>
          ) : (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Released</dt>
                <dd>{detail.publishedAt ? new Date(detail.publishedAt).toLocaleString() : "—"}</dd>
                <dt className="text-muted-foreground">Published by</dt>
                <dd>{detail.publisherName ?? "Unknown"}</dd>
                <dt className="text-muted-foreground">Delivered to</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {deliveredLabels.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    deliveredLabels.map((label) => (
                      <Badge key={label} variant="secondary">
                        {label}
                      </Badge>
                    ))
                  )}
                </dd>
              </dl>

              <div className="min-h-0 flex-1 overflow-y-auto border-t border-border pt-4">
                <h2 className="mb-4 text-2xl font-bold leading-tight tracking-tight">{detail.title}</h2>
                <div className="mdx-content" dangerouslySetInnerHTML={{ __html: detail.bodyHtml }} />
                {detail.linkedinBody && detail.linkedinBody.trim() && (
                  <div className="mt-6 border-t border-border pt-4">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      LinkedIn copy
                    </p>
                    <p className="whitespace-pre-wrap text-sm">{detail.linkedinBody}</p>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
