"use client";

import { SquarePlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DisabledHint } from "../_components/disabled-hint";
import { ImportDialog } from "../change-events/import-dialog";
import type { ImportRepo } from "../change-events/actions";
import {
  createAtomicUpdateFromCommits,
  createAtomicUpdateFromPullRequests,
} from "../change-events/import-actions";
import type { CommitSelection } from "@/lib/change-events/import-commits";
import type { PullRequestSelection } from "@/lib/change-events/import-pull-requests";

/**
 * "New atomic update" on `/atomic-updates`. Shows the EXACT same change-event
 * selector as the change-events import modal (`ImportDialog`) — repo tabs,
 * search, the type dropdown, After/Before, GitHub commits/PRs — differing only
 * in the CTA: instead of importing the selected events into the pool, it
 * imports them AND groups them into ONE new atomic update
 * (`createAtomicUpdateFrom{Commits,PullRequests}`).
 */
export function NewAtomicUpdateDialog({ repos }: { repos: ImportRepo[] }) {
  // Only commits and PRs can seed an atomic update here, so a watched repo is
  // the hard requirement. Render the disabled button on its own rather than as
  // the dialog's trigger — the dialog has nothing to show without repos, and a
  // bare trigger is what the hint can wrap.
  if (repos.length === 0) {
    return (
      <DisabledHint hint="Connect GitHub and watch a repo to create atomic updates.">
        <Button variant="outline" disabled>
          <SquarePlus />
          New atomic update
        </Button>
      </DisabledHint>
    );
  }

  return (
    <ImportDialog
      repos={repos}
      trigger={
        <Button variant="outline">
          <SquarePlus />
          New atomic update
        </Button>
      }
      title="New atomic update"
      description="Select the commits or pull requests that make up this change — they'll be grouped into one new atomic update."
      submitLabel={({ count, submitting }) =>
        submitting ? "Creating…" : `Create atomic update${count > 0 ? ` (${count})` : ""}`
      }
      commitSubmit={async (selections: CommitSelection[]) => {
        const result = await createAtomicUpdateFromCommits({ selections });
        if (!result.ok) throw new Error(result.reason);
        toast.success("Atomic update created");
      }}
      pullRequestSubmit={async (selections: PullRequestSelection[]) => {
        const result = await createAtomicUpdateFromPullRequests({ selections });
        if (!result.ok) throw new Error(result.reason);
        toast.success("Atomic update created");
      }}
      resolveErrorMessage={(e) =>
        e instanceof Error && e.message ? e.message : "Couldn't create the atomic update."
      }
    />
  );
}
