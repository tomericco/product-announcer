"use client";

import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImportDialog } from "../change-events/import-dialog";
import type { ImportRepo } from "../change-events/actions";
import {
  addCommitsToAtomicUpdate,
  addPullRequestsToAtomicUpdate,
} from "../change-events/import-actions";
import type { CommitSelection } from "@/lib/change-events/import-commits";
import type { PullRequestSelection } from "@/lib/change-events/import-pull-requests";

/**
 * "Add change events" on an atomic update card's evidence editor (edit mode).
 * Shows the EXACT same change-event selector as the change-events import modal
 * and the "New atomic update" modal (`ImportDialog`) — repo tabs, search, the
 * type dropdown, After/Before, GitHub commits/PRs — differing only in the CTA:
 * it imports the selected events and adds them as evidence to THIS atomic
 * update (`addImportedCommitsToAtomicUpdate` / …PullRequests…), which
 * regenerates the update's title/summary from the new, larger evidence set.
 */
export function AddEventPicker({
  atomicUpdateId,
  repos,
}: {
  atomicUpdateId: string;
  repos: ImportRepo[];
}) {
  return (
    <ImportDialog
      repos={repos}
      trigger={
        <Button type="button" variant="outline" size="sm" disabled={repos.length === 0}>
          <Plus />
          Add change events
        </Button>
      }
      title="Add change events"
      description="Select the commits or pull requests to add as evidence for this atomic update — it'll be regenerated from the new evidence."
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
      resolveErrorMessage={(e) =>
        e instanceof Error && e.message ? e.message : "Couldn't add the change events."
      }
    />
  );
}
