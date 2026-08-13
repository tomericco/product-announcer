"use client";

import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DisabledHint } from "../_components/disabled-hint";
import { ImportDialog } from "../change-events/import-dialog";
import type { ImportRepo } from "@/lib/change-events/list";
import {
  addCommitsToAtomicUpdate,
  addPullRequestsToAtomicUpdate,
  addTasksToAtomicUpdate,
  type TaskSelection,
} from "../change-events/import-actions";
import type { CommitSelection } from "@/lib/change-events/import-commits";
import type { PullRequestSelection } from "@/lib/change-events/import-pull-requests";

/**
 * "Add change events" on an atomic update card's evidence editor (edit mode).
 * Shows the EXACT same change-event selector as the change-events import modal
 * and the "New atomic update" modal (`ImportDialog`) — repo tabs, search, the
 * type dropdown, After/Before, GitHub commits/PRs, Notion tasks — differing only
 * in the CTA: it imports the selected events and adds them as evidence to THIS
 * atomic update (`addImported{Commits,PullRequests,Tasks}ToAtomicUpdate`), which
 * regenerates the update's title/summary from the new, larger evidence set.
 */
export function AddEventPicker({
  atomicUpdateId,
  repos,
  notionConnected = false,
}: {
  atomicUpdateId: string;
  repos: ImportRepo[];
  notionConnected?: boolean;
}) {
  // Either source can supply evidence, so only a workspace with neither is stuck.
  if (repos.length === 0 && !notionConnected) {
    return (
      <DisabledHint hint="Connect GitHub or Notion to add change events">
        <Button type="button" variant="outline" size="sm" disabled>
          <Plus />
          Add change events
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
        <Button type="button" variant="outline" size="sm">
          <Plus />
          Add change events
        </Button>
      }
      title="Add change events"
      description="Select the commits, pull requests, or tasks to add as evidence for this atomic update — it'll be regenerated from the new evidence."
      submitLabel={({ count, submitting }) =>
        submitting ? "Adding…" : `Add ${count} event${count === 1 ? "" : "s"}`
      }
      commitSubmit={async (selections: CommitSelection[]) => {
        const result = await addCommitsToAtomicUpdate({ atomicUpdateId, selections });
        if (!result.ok) throw new Error(result.reason);
        toast.success("Change events added");
      }}
      pullRequestSubmit={async (selections: PullRequestSelection[]) => {
        const result = await addPullRequestsToAtomicUpdate({ atomicUpdateId, selections });
        if (!result.ok) throw new Error(result.reason);
        toast.success("Change events added");
      }}
      taskSubmit={async (selections: TaskSelection[]) => {
        const result = await addTasksToAtomicUpdate({ atomicUpdateId, selections });
        if (!result.ok) throw new Error(result.reason);
        toast.success("Change events added");
      }}
      resolveErrorMessage={(e) =>
        e instanceof Error && e.message ? e.message : "Couldn't add the change events."
      }
    />
  );
}
