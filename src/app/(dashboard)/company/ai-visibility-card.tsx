"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { Source } from "@/db/schema";
import { setAiVisibilityWatching } from "./actions";
import { DATE_FORMAT, SourceStatusBadge } from "./source-status";

/**
 * The Company page's half of AI visibility: on/off, health, and the two
 * routes into the feature. Follows `NewsToggle` exactly — the toggle IS the
 * save, with no form or button of its own, and an optimistic flip that
 * reverts on failure, because the optimistic value left on screen after a
 * failed save is indistinguishable from a successful one.
 *
 * The derivation line ("prompts generated from 5 competitors, 3 personas")
 * is what keeps the proximity the researcher wanted after the dashboard was
 * given its own nav item: this is the page those inputs are edited on, so
 * this is where the consequence of editing them belongs.
 */
export function AiVisibilityCard({
  source,
  promptCount,
  competitorCount,
  personaCount,
  changedSinceCount,
}: {
  source: Source | null;
  promptCount: number;
  competitorCount: number;
  personaCount: number;
  changedSinceCount: number;
}) {
  const [enabled, setEnabled] = useState(source ? source.status !== "disabled" : false);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function toggle(next: boolean) {
    setEnabled(next);
    setPending(true);
    try {
      await setAiVisibilityWatching(next);
      router.refresh();
    } catch {
      setEnabled(!next);
      toast.error("Couldn't update AI visibility — try again");
    } finally {
      setPending(false);
    }
  }

  const derivation = `Prompts generated from ${competitorCount} competitor${
    competitorCount === 1 ? "" : "s"
  }, ${personaCount} persona${personaCount === 1 ? "" : "s"}${
    changedSinceCount > 0 ? ` — ${changedSinceCount} changed since` : ""
  }`;

  return (
    <div className="space-y-3">
      <Label>
        <Switch
          checked={enabled}
          disabled={pending}
          aria-label="Track AI visibility"
          onCheckedChange={toggle}
        />
        Track AI visibility
      </Label>
      <p className="text-xs text-muted-foreground">
        Asks ChatGPT, Perplexity, Gemini and Claude the questions your buyers ask, on a schedule you set
        in Settings. Off means nothing runs and nothing is billed; anything already measured is kept.
      </p>

      {promptCount > 0 && <p className="text-xs text-muted-foreground">{derivation}</p>}

      {/* Shown whenever a source row exists, INCLUDING while switched off:
          turning the toggle off after a failure must not hide the reason. */}
      {source && (
        <ul className="space-y-1.5 pl-1">
          <li className="rounded-md border border-dashed p-2 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="truncate font-medium">{source.label}</span>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-muted-foreground">
                  {source.lastRunAt ? `Last ran ${DATE_FORMAT.format(source.lastRunAt)}` : "Not run yet"}
                </span>
                <SourceStatusBadge status={source.status} />
              </div>
            </div>
            <p className="text-muted-foreground">
              {source.lastSuccessAt
                ? `Last ran without errors ${DATE_FORMAT.format(source.lastSuccessAt)}`
                : "Hasn't completed a clean run yet"}
            </p>
            {source.lastError && <p className="mt-1 text-destructive">{source.lastError}</p>}
          </li>
        </ul>
      )}

      {/* Styled Links rather than `Button render={<Link/>}`: Base UI's Button
          stamps role="button" onto whatever it renders, and both of these do
          nothing but navigate — the same call every navigate-only control on
          /ai-visibility makes. */}
      <div className="flex flex-wrap gap-2">
        <Link
          href="/ai-visibility/prompts"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Edit prompts
        </Link>
        <Link href="/ai-visibility" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          View results
        </Link>
      </div>
    </div>
  );
}
