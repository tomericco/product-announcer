"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Split } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { EDIT_STEPS, type DraftProgressEvent, type DraftStepKey } from "@/lib/scheduling/draft-progress";
import {
  ProgressChecklist,
  initialStepStatuses,
  type StepStatus,
} from "@/components/draft-progress-checklist";
import { readDraftProgress } from "@/lib/scheduling/read-draft-progress";
import { useUnsavedChanges } from "../../unsaved-changes";
import { useAgentEdit } from "./agent-edit-context";

/**
 * Confirms and runs a split: the highlighted passage leaves this draft and
 * becomes one of its own, rewritten by the same generate → review → save
 * pipeline as the initial compose (hence the shared step checklist).
 *
 * The deletion happens client-side BEFORE the request, because only Lexical
 * knows the selection's structure — so between that deletion and the server's
 * commit, the passage exists nowhere but this browser tab. The catch block's
 * restore is therefore load-bearing, not politeness.
 */
export function ExtractDialog({ releaseId }: { releaseId: string }) {
  const { state, close, ops } = useAgentEdit();
  const { notifySaved } = useUnsavedChanges();
  const router = useRouter();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [statuses, setStatuses] = useState<Record<DraftStepKey, StepStatus>>(() =>
    initialStepStatuses(EDIT_STEPS)
  );
  const [detail, setDetail] = useState("");

  const open = state?.mode === "extract";

  function reset() {
    setInstruction("");
    setStatuses(initialStepStatuses(EDIT_STEPS));
    setDetail("");
    close();
  }

  async function runExtract(remainingBody: string, excerpt: string, trimmed: string) {
    // A prior failed attempt may have left steps marked active/done and a
    // stale detail string — re-arm before this run emits anything of its own.
    setStatuses(initialStepStatuses(EDIT_STEPS));
    setDetail("");

    // Wrapped narrowly: only a rejected fetch (network down, server
    // unreachable) needs normalizing to the friendly message below. A stream
    // the server deliberately sends with an `error` event must keep its own
    // message, so the read loop stays outside this try.
    let res: Response;
    try {
      res = await fetch("/api/drafts/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ releaseId, excerpt, remainingBody, instruction: trimmed }),
      });
    } catch {
      throw new Error("Couldn't start the extraction. Please try again.");
    }
    if (!res.ok || !res.body) {
      throw new Error("Couldn't start the extraction. Please try again.");
    }

    let newReleaseId: string | null = null;
    let errored: string | null = null;
    const handle = (event: DraftProgressEvent) => {
      if (event.type === "step") {
        setStatuses((prev) => ({ ...prev, [event.key]: event.status === "start" ? "active" : "done" }));
      } else if (event.type === "detail") {
        setDetail(event.text);
      } else if (event.type === "done") {
        newReleaseId = event.updateId;
      } else if (event.type === "error") {
        errored = event.message;
      }
    };

    await readDraftProgress(res.body, handle);

    if (errored) throw new Error(errored);
    if (newReleaseId == null) throw new Error("The extraction finished without creating a draft.");
    return newReleaseId as string;
  }

  function submit() {
    if (!state || state.mode !== "extract") return;
    const editorOps = ops.current;
    if (!editorOps) {
      toast.error("The editor isn't ready yet — try again in a moment.");
      return;
    }
    const excerpt = state.excerpt;
    const trimmed = instruction.trim();

    setBusy(true);
    void (async () => {
      // The only surviving copy of the passage once removeSelection runs.
      const originalBody = editorOps.getMarkdown();
      let removed = false;
      try {
        const remainingBody = await editorOps.removeSelection();
        removed = true;
        if (remainingBody.trim().length === 0) {
          throw new Error("You can't extract the entire update — leave some text behind.");
        }

        const newReleaseId = await runExtract(remainingBody, excerpt, trimmed);

        // The server persisted the trimmed source body, so the editor is in
        // sync with the DB again and the unsaved-changes guard must be cleared.
        notifySaved();
        toast.success("Extracted as a new draft", {
          action: { label: "Open", onClick: () => router.push(`/drafts/${newReleaseId}`) },
        });
        reset();
      } catch (error) {
        // Tell the user what happened before attempting the restore — if the
        // restore itself throws below, this message must already be visible,
        // not lost underneath a second toast.
        toast.error(error instanceof Error ? error.message : "Something went wrong");
        // Put the passage back — nothing else holds it at this point. Its own
        // try/catch: a failed restore must not escape silently, since that
        // would drop the user back at the form with the passage simply gone.
        if (removed) {
          try {
            await editorOps.applyEdit("whole", originalBody);
          } catch {
            // The blockquote above the textarea (still showing `state.excerpt`,
            // since this catch never calls reset()) is the last remaining copy
            // — say so plainly.
            toast.error(
              "Couldn't restore the removed text automatically. It's still shown above — copy it before closing this dialog."
            );
          }
        }
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && reset()}>
      <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Split className="size-4" /> Extract as a separate update
          </DialogTitle>
          <DialogDescription>
            The highlighted text is removed from this update and rewritten as a standalone draft,
            reviewed against your brand guidelines.
          </DialogDescription>
        </DialogHeader>

        {busy ? (
          <ProgressChecklist steps={EDIT_STEPS} statuses={statuses} detail={detail} className="py-2" />
        ) : (
          <div className="space-y-3">
            <blockquote className="max-h-32 overflow-auto rounded-md border bg-muted/50 p-2 text-sm whitespace-pre-wrap text-muted-foreground">
              {state?.excerpt}
            </blockquote>
            <Textarea
              autoFocus
              rows={3}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Optional: how should the new update be framed? e.g. Lead with the API change"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
              }}
            />
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" disabled={busy} />}>Cancel</DialogClose>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Working…" : "Extract"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
