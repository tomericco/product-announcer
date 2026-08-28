"use client";

import { useState, useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
// Type-only: `source-evidence-actions.ts` is a "use server" module with a
// top-level `db` import, so its types must be erased at this boundary. The
// ACTION below is imported as a value on purpose — that is a Server Function
// reference, not a runtime value out of a server module.
import type { SourceEvidenceView } from "./source-evidence-actions";
import { loadSourceEvidence } from "./source-evidence-actions";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty" }
  | { status: "loaded"; view: SourceEvidenceView };

/**
 * The record behind one link-backed signal — `market_news`,
 * `competitor_move`, `manual`: the page(s) it is based on, the text that was
 * actually read, and why it was kept.
 *
 * These kinds had no evidence control at all, on the reasoning that only
 * `shipped_work` and `ai_visibility` have anything behind them. That was
 * wrong about the link: `signals.url` holds the article (or watched page)
 * every one of these was built from, and it was rendered nowhere but as the
 * row title's own href — no icon, no domain, nothing marking it as a link. So
 * the source of a market-news row was reachable only by guessing the title
 * was clickable.
 *
 * Read-only, like `AiVisibilityEvidence` and unlike `EvidenceDrawer`: this is
 * a record of a page someone else published at a moment in time. Loads on
 * open and resets on close, for the same reason both neighbours do — most
 * rows are never expanded, so the list must not pay for evidence nobody asked
 * for, and a re-open should read fresh.
 */
export function SourceEvidence({ signalId, title }: { signalId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [, startTransition] = useTransition();

  function handleOpenChange(next: boolean) {
    if (next && state.status === "idle") {
      setState({ status: "loading" });
      startTransition(async () => {
        const view = await loadSourceEvidence(signalId);
        setState(view ? { status: "loaded", view } : { status: "empty" });
      });
    }
    if (!next) setState({ status: "idle" });
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            Evidence
          </Button>
        }
      />
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>The pages this signal is based on, and what was read.</DialogDescription>
        </DialogHeader>

        {(state.status === "idle" || state.status === "loading") && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}

        {state.status === "empty" && (
          <p className="text-sm text-muted-foreground">
            No record behind this signal — it may have aged out of the 60-day window.
          </p>
        )}

        {state.status === "loaded" && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{state.view.kindLabel}</Badge>
              {state.view.competitorName && <Badge variant="outline">{state.view.competitorName}</Badge>}
              <span className="text-xs text-muted-foreground">{state.view.occurredAtLabel}</span>
            </div>

            <section className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Sources</h3>
              {state.view.links.length === 0 ? (
                // Reachable: a `manual` signal can be filed with no URL at all,
                // and `signals.url` is nullable for every kind.
                <p className="text-sm text-muted-foreground">
                  No link was recorded for this signal.
                  {state.view.sourceLabel ? ` It came from "${state.view.sourceLabel}".` : ""}
                </p>
              ) : (
                state.view.links.map((link) => (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-start gap-2 rounded-md border p-2 hover:bg-accent"
                  >
                    <ExternalLink className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium">{link.label}</span>
                      {link.domain && <span className="text-xs text-muted-foreground">{link.domain}</span>}
                      {/* The full URL, wrapped rather than truncated: checking a
                          signal against its source means reading the path, not
                          just the host. */}
                      <span className="text-xs break-all text-muted-foreground">{link.url}</span>
                    </span>
                  </a>
                ))
              )}
            </section>

            {state.view.excerpt && (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-xs font-medium text-muted-foreground">What was read</h3>
                <p className="text-sm whitespace-pre-wrap text-muted-foreground">{state.view.excerpt}</p>
              </section>
            )}

            {state.view.relevanceRationale && (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-xs font-medium text-muted-foreground">Why it was kept</h3>
                <p className="text-sm text-muted-foreground">{state.view.relevanceRationale}</p>
                {state.view.relevanceScore !== null && (
                  <span className="text-xs text-muted-foreground">
                    Score {state.view.relevanceScore.toFixed(2)}
                  </span>
                )}
              </section>
            )}

            {state.view.topics.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-xs font-medium text-muted-foreground">Topics</h3>
                <div className="flex flex-wrap gap-1.5">
                  {state.view.topics.map((topic) => (
                    <Badge key={topic} variant="outline">
                      {topic}
                    </Badge>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
