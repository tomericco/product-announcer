"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import type { PreflightItem } from "@/lib/ai-visibility/preflight";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DisabledHint } from "../_components/disabled-hint";
import { runNowAction } from "./actions";

export type RunEstimate = { prompts: number; engines: number; samples: number; calls: number; usd: number };

/**
 * The cost, in dollars, before anything is spent — the design's trust cue,
 * and the reason there is a confirmation dialog at all. Never credits: the
 * research found credit systems are disliked precisely because they hide
 * this number.
 *
 * `calls` is quoted, and the three factors are demoted to a parenthetical that
 * says "up to". The sentence used to read "≈ 26 prompts × 3 engines × 3
 * samples", inviting the reader to multiply — and the product was wrong: 234
 * against a real plan of 216, because brand-check prompts are sampled ONCE per
 * engine whatever the samples setting says. A trust cue whose own arithmetic
 * does not check out is worse than no trust cue, and this is the one screen
 * that has to be right about money. `calls` comes from `plannedCallsForPrompts`,
 * which is the count the planner actually inserts.
 */
export function estimateSentence(estimate: RunEstimate): string {
  return `≈ ${estimate.calls} calls — ${estimate.prompts} prompts × ${estimate.engines} engines × up to ${estimate.samples} samples — about $${estimate.usd.toFixed(2)}`;
}

/**
 * "Run now" — the /ai-visibility header control. Only there: the /company card
 * offers the two navigation links and the on/off switch, and nothing that
 * spends money. Disabled states carry their reason twice on purpose: in a
 * `DisabledHint` for the pointer, and as a line under the button, because
 * "Paused — monthly engine budget reached" must be readable without hovering.
 *
 * It owns the whole control cluster rather than just the button: Stop and
 * Resume come in through `actions` and render on the button's own row, inside
 * the same column the reason line sits under. They used to be siblings of this
 * component in the page's flex row, which put a one-line button beside a
 * two-line column and left "Stop" floating against the top of "Run now" with
 * its status line hanging past the bottom. The status line describes the run
 * that Stop stops, so the three belong to one block.
 */
export function RunNowButton({
  estimate,
  disabledReason,
  disabledTone = "muted",
  label = "Run now",
  actions,
  footnote,
  warnings = [],
}: {
  estimate: RunEstimate;
  disabledReason: string | null;
  /**
   * The tone of the reason line. `--destructive` owns warnings and errors, and
   * the cap is one; a run being in progress is not, and painting "Running…
   * 41 / 270 calls" red reports a healthy run as a failure.
   */
  disabledTone?: "muted" | "destructive";
  label?: string;
  /**
   * Controls that belong beside this one — Stop while a run is in flight,
   * Resume while it is stalled. Rendered BEFORE the button: "Run now" is the
   * primary and the only filled control here, and a filled button reads as the
   * end of a row rather than the middle of one.
   */
  actions?: ReactNode;
  /**
   * The line under the button when there is nothing blocking a run — today,
   * "Next scan in 3 days". Never shown alongside `disabledReason`: that
   * sentence occupies the same slot and outranks it, because "no engine key is
   * connected" is what the reader needs before a schedule they are not going
   * to get.
   */
  footnote?: ReactNode;
  /**
   * Readiness warnings from `preflightRun` — things that make the run buy LESS
   * than the estimate implies without stopping it: no competitors to benchmark
   * against, no website to attribute citations to, prompts older than the
   * profile they were drafted from.
   *
   * Only warnings ever arrive here, and that is structural rather than a
   * convention: preflight's BLOCKS are what the page turns into
   * `disabledReason`, and a disabled button renders no dialog at all. So the
   * split is "a block is a sentence under the button you cannot press, a
   * warning is a line in the dialog you are about to confirm".
   */
  warnings?: PreflightItem[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function start() {
    startTransition(async () => {
      const result = await runNowAction();
      if (result.ok) {
        setOpen(false);
        // The overview reads run state on the server; refreshing is what
        // swaps the header into "Running… 41 / 270 calls".
        router.refresh();
        toast.success("Run started");
      } else {
        toast.error(result.error);
      }
    });
  }

  // One shape for both states — a column of [actions + button] over a caption —
  // so a disabled run and a runnable one occupy the same block and the row does
  // not reflow when a run starts.
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {actions}
        {disabledReason ? (
          <DisabledHint hint={disabledReason}>
            <Button disabled>{label}</Button>
          </DisabledHint>
        ) : (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button>{label}</Button>} />
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>{label}?</DialogTitle>
                <DialogDescription>
                  {estimateSentence(estimate)}. Most runs finish in a few minutes; anything left over
                  completes with the next daily sweep. Content changes show in 60–90 days.
                </DialogDescription>
              </DialogHeader>
              {/* Muted, not `--destructive`, and the choice is about what this
                  dialog is for. Its primary action spends money, and painting
                  "no competitors yet" in the error hue beside that button reads
                  as "do not press this" — which is wrong: the run is worth
                  making, it just buys one section less than a fully set-up
                  workspace would. Each carries its own route out, because the
                  moment somebody is told what is missing is the moment they can
                  act on it. */}
              {warnings.length > 0 && (
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {warnings.map((warning) => (
                    <li key={warning.id} className="flex gap-2">
                      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      <span>
                        {warning.message}
                        {warning.fix && (
                          <>
                            {" "}
                            <Link
                              href={warning.fix.href}
                              className="underline underline-offset-2 hover:text-foreground"
                            >
                              {warning.fix.label}
                            </Link>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" disabled={pending} />}>Cancel</DialogClose>
                <Button onClick={start} disabled={pending}>
                  {pending ? "Starting…" : label}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
      {disabledReason ? (
        <p
          className={
            disabledTone === "destructive" ? "text-xs text-destructive" : "text-xs text-muted-foreground"
          }
        >
          {disabledReason}
        </p>
      ) : (
        footnote && <p className="text-xs text-muted-foreground">{footnote}</p>
      )}
    </div>
  );
}
