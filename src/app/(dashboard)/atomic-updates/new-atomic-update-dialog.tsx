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
  createAtomicUpdateFromTasks,
  type TaskSelection,
} from "../change-events/import-actions";
import type { CommitSelection } from "@/lib/change-events/import-commits";
import type { PullRequestSelection } from "@/lib/change-events/import-pull-requests";

/**
 * "New atomic update" on `/atomic-updates`. Shows the EXACT same change-event
 * selector as the change-events import modal (`ImportDialog`) — repo tabs,
 * search, the type dropdown, After/Before, GitHub commits/PRs, Notion tasks —
 * differing only in the CTA: instead of importing the selected events into the
 * pool, it imports them AND groups them into ONE new atomic update
 * (`createAtomicUpdateFrom{Commits,PullRequests,Tasks}`).
 */
export function NewAtomicUpdateDialog({
  repos,
  notionConnected = false,
}: {
  repos: ImportRepo[];
  notionConnected?: boolean;
}) {
  // Either source can seed an update, so only a workspace with neither is stuck.
  // Render the disabled button on its own rather than as the dialog's trigger —
  // the dialog has nothing to show, and a bare trigger is what the hint wraps.
  if (repos.length === 0 && !notionConnected) {
    return (
      <DisabledHint hint="Connect GitHub or Notion to create atomic updates">
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
      enableTasks={notionConnected}
      notionConnected={notionConnected}
      trigger={
        <Button variant="outline">
          <SquarePlus />
          New atomic update
        </Button>
      }
      title="New atomic update"
      description="Select the commits, pull requests, or tasks that make up this change — they'll be grouped into one new atomic update."
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
      taskSubmit={async (selections: TaskSelection[]) => {
        const result = await createAtomicUpdateFromTasks({ selections });
        if (!result.ok) throw new Error(result.reason);
        toast.success("Atomic update created");
      }}
      resolveErrorMessage={(e) =>
        e instanceof Error && e.message ? e.message : "Couldn't create the atomic update."
      }
    />
  );
}
