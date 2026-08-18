"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setNewsWatching } from "./actions";
import { DATE_FORMAT, SourceStatusBadge } from "./source-status";
import type { Source } from "@/db/schema";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/**
 * The "Industry news" opt-in. Unlike CompetitorsEditor there is at most one
 * source -- the null-url identity index from spec 4 enforces that -- and it's
 * a boolean the tenant flips, not a list they curate, so this is a toggle
 * plus a health block rather than an editor.
 *
 * "Off" is exactly `status: "disabled"`, which is what stops sweepNewsSources
 * (spec 4) from spending a Tavily credit on this tenant every day. Follows
 * IndustrySelect's shape: the toggle is the save, with no form or button of
 * its own, and an optimistic flip that reverts on failure.
 */
export function NewsToggle({ source }: { source: Source | null }) {
  const [enabled, setEnabled] = useState(source ? source.status !== "disabled" : false);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function toggle(next: boolean) {
    setEnabled(next);
    setPending(true);
    try {
      await setNewsWatching(next);
      router.refresh();
    } catch {
      // The optimistic value stays on screen otherwise, which looks
      // identical to a successful flip that just hasn't spent a credit yet.
      setEnabled(!next);
      toast.error("Couldn't update news watching — try again");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <Label>
        <Switch checked={enabled} disabled={pending} onCheckedChange={toggle} />
        Watch industry news
      </Label>
      <p className="text-xs text-muted-foreground">
        Searches news each day against the topics in your company profile. Add topics above to change what it looks
        for.
      </p>
      {/* Shown whenever a source row exists, including while it's switched
          off: turning the toggle off after a failure must not hide the reason
          it failed — that's the one moment an operator most wants to read it. */}
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
            {/* `lastSuccessAt` means "last error-free run" — it is set even
                when the run wrote zero signals — so it is worded exactly as
                competitors-editor.tsx words the same field. Calling it "last
                found something" told a tenant whose agent has never produced
                a signal that it had. */}
            <p className="text-muted-foreground">
              {source.lastSuccessAt
                ? `Last ran without errors ${DATE_FORMAT.format(source.lastSuccessAt)}`
                : "Hasn't completed a clean run yet"}
            </p>
            {source.lastError && <p className="mt-1 text-destructive">{source.lastError}</p>}
          </li>
        </ul>
      )}
    </div>
  );
}
