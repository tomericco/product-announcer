"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { HighlightedAnswer } from "../ai-visibility/prompts/[promptId]/highlighted-answer";
// Type-only: `ai-visibility-actions.ts` is a "use server" module, so its types
// must be erased at the boundary. The ACTION itself is imported as a value
// below — that is a Server Function reference and is exactly what is wanted.
import type { AiVisibilityEvidenceView } from "./ai-visibility-actions";
import { loadAiVisibilityEvidence } from "./ai-visibility-actions";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty" }
  | { status: "loaded"; view: AiVisibilityEvidenceView };

/**
 * The read-only record behind one `ai_visibility` signal: which prompt, on
 * which engine and model, on which date, over how many samples, what the
 * engine actually said, and which pages it cited in order.
 *
 * Read-only on purpose, and the absence of controls is the point: this is a
 * record of what a third party said at a moment in time. There is nothing
 * here a human could correct that would not be a lie about the measurement.
 * `EvidenceDrawer` next door is the opposite — an atomic-update CURATION tool
 * whose every write is guarded on an atomic update's `status='open'` — so
 * this is a separate component in the same visual language rather than a
 * branch inside that one.
 *
 * Loads on open, like `EvidenceDrawer`, and for the same reason: most rows
 * in the browser are never expanded, so the list page must not pay for
 * evidence nobody asked for. State resets on close so a re-open reads fresh.
 */
export function AiVisibilityEvidence({ signalId, title }: { signalId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [, startTransition] = useTransition();

  function handleOpenChange(next: boolean) {
    if (next && state.status === "idle") {
      setState({ status: "loading" });
      startTransition(async () => {
        const view = await loadAiVisibilityEvidence(signalId);
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
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>What the engine said, and where it got it.</DialogDescription>
        </DialogHeader>

        {(state.status === "idle" || state.status === "loading") && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}

        {state.status === "empty" && (
          <p className="text-sm text-muted-foreground">
            No evidence behind this signal — the answers it was based on may have aged out.
          </p>
        )}

        {state.status === "loaded" && (
          <div className="space-y-3">
            <div>
              <p className="text-xs text-muted-foreground">Prompt</p>
              <p className="text-sm font-medium">{state.view.promptText}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="secondary">{state.view.engineLabel}</Badge>
              {state.view.modelId && (
                <span className="font-mono text-muted-foreground">{state.view.modelId}</span>
              )}
              <span className="text-muted-foreground">{state.view.runDateLabel}</span>
              <span className="text-muted-foreground">{state.view.samples}</span>
            </div>

            {state.view.excerpt && (
              <div className="rounded-md border p-2">
                <HighlightedAnswer text={state.view.excerpt} aliases={state.view.aliases} />
              </div>
            )}

            {state.view.citedUrls.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Cited sources, in order</p>
                <ul className="space-y-1 text-sm">
                  {state.view.citedUrls.map((citation, index) => (
                    <li key={`${citation.url}-${index}`} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground tabular-nums">{index + 1}.</span>
                      <a
                        href={citation.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate hover:underline"
                        title={citation.url}
                      >
                        {citation.domain}
                      </a>
                      <Badge variant="outline">{citation.domainClass}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter showCloseButton>
          {state.status === "loaded" && state.view.promptId && (
            // A styled Link, not `Button render={<Link/>}`: Base UI's Button
            // stamps role="button" onto whatever it renders, and this control
            // does nothing but navigate. Same call the /ai-visibility surface
            // already makes for every navigate-only control.
            <Link
              href={`/ai-visibility/prompts/${state.view.promptId}`}
              className={buttonVariants({ variant: "ghost" })}
            >
              Open prompt
            </Link>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
