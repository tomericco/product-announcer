"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
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
  enabled: initialEnabled,
  promptCount,
  competitorCount,
  personaCount,
  newCompetitorCount,
  profileChanged,
}: {
  source: Source | null;
  /**
   * `ai_visibility_settings.enabled` — the column `sweep.ts` actually gates
   * on, and therefore the only honest thing to seed this switch from.
   *
   * NOT `source.status !== "disabled"`. A source row can exist and read
   * `active` while the feature has never been switched on (`planRun` creates
   * one, and so did an earlier version of this page), which showed a checked
   * switch and a green badge beside this card's own "it's off until you turn
   * it on" — and nothing ran until the user toggled off and back on.
   */
  enabled: boolean;
  promptCount: number;
  competitorCount: number;
  personaCount: number;
  /** Competitors added since the newest active prompt was approved. */
  newCompetitorCount: number;
  /** Whether the company profile itself has been edited since then. */
  profileChanged: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
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
  }, ${personaCount} persona${personaCount === 1 ? "" : "s"}`;

  // Worded exactly as the prompts page words the same derivation, and for the
  // same reason: `companyProfiles.updatedAt` is bumped by a dozen unrelated
  // writes (guidelines, visual identity, topics, a brand import), so folding
  // it into a COUNT attached to a sentence about competitors and personas
  // makes uploading a logo read as "1 persona changed". Named separately, it
  // says only what it knows.
  const changes: string[] = [];
  if (newCompetitorCount > 0) {
    changes.push(`${newCompetitorCount} competitor${newCompetitorCount === 1 ? "" : "s"}`);
  }
  if (profileChanged) changes.push("an updated profile");
  const changedNote =
    changes.length > 0 ? `Profile changed since prompts were generated — ${changes.join(", ")}` : null;

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
        Asks ChatGPT, Gemini and Claude the questions your buyers ask, on a schedule you set
        in Settings. Off means nothing runs and nothing is billed; anything already measured is kept.
      </p>

      {promptCount > 0 && <p className="text-xs text-muted-foreground">{derivation}</p>}
      {promptCount > 0 && changedNote && (
        <p className="text-xs text-muted-foreground">{changedNote}</p>
      )}

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
            {/* Toned by the status, not by the mere presence of a message.
                Unlike news and competitors, this source's `lastError` also
                carries benign refusals — the sweep records "No active prompts —
                approve a prompt set to start measuring." and deliberately does
                NOT set `failing` for it — so keying the colour off the string
                painted that sentence red beside a green Active badge, and
                `--destructive` owns real failures only. */}
            {source.lastError && (
              <p
                className={cn(
                  "mt-1",
                  source.status === "failing" ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {source.lastError}
              </p>
            )}
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
