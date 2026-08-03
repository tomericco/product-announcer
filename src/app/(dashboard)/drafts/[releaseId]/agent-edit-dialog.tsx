"use client";

import { useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
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
import { useAgentEdit, type EditorOps } from "./agent-edit-context";
import { requestAgentEdit, saveDraftBody } from "./actions";

/**
 * Shared "Ask for changes" modal for both entry points.
 *
 * - Selection mode: a single-shot scoped edit — ask the agent, splice the
 *   revised excerpt back in place, persist, behind a simple spinner.
 * - Whole mode: streams the SAME generate → review-against-guidelines → save
 *   pipeline as the initial compose, shown with the stepped checklist loader.
 *
 * Rendered once at page level; open state and mode come from the agent-edit
 * context.
 */
export function AgentEditDialog({ contentPieceId }: { contentPieceId: string }) {
  const { state, close, ops } = useAgentEdit();
  const { notifySaved } = useUnsavedChanges();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [statuses, setStatuses] = useState<Record<DraftStepKey, StepStatus>>(() =>
    initialStepStatuses(EDIT_STEPS)
  );
  const [detail, setDetail] = useState("");

  // Only this modal's own modes. The provider's state is shared with the
  // extract flow, which has its own dialog — without this gate both would open
  // at once and Ask AI's submit would run a whole-body rewrite on an extract.
  const open = state?.mode === "selection" || state?.mode === "whole";

  function reset() {
    setInstruction("");
    setStatuses(initialStepStatuses(EDIT_STEPS));
    setDetail("");
    close();
  }

  // Whole-update edit: consume the NDJSON progress stream from the pipeline
  // route, drive the step checklist, then drop the reviewed body (which the
  // route already persisted) into the editor.
  async function runWholeEdit(editorOps: EditorOps, fullBody: string, trimmed: string) {
    setStatuses(initialStepStatuses(EDIT_STEPS));
    setDetail("");

    const res = await fetch("/api/drafts/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentPieceId, instruction: trimmed, fullBody }),
    });
    if (!res.ok || !res.body) {
      throw new Error("Couldn't start the edit. Please try again.");
    }

    let finalBody: string | null = null;
    let errored: string | null = null;
    const handle = (event: DraftProgressEvent) => {
      if (event.type === "step") {
        setStatuses((prev) => ({ ...prev, [event.key]: event.status === "start" ? "active" : "done" }));
      } else if (event.type === "detail") {
        setDetail(event.text);
      } else if (event.type === "done") {
        finalBody = event.body ?? null;
      } else if (event.type === "error") {
        errored = event.message;
      }
    };

    await readDraftProgress(res.body, handle);

    if (errored) throw new Error(errored);
    if (finalBody == null) throw new Error("The edit finished without a result.");

    // The route persisted the reviewed body server-side; mirror it into the
    // editor and re-sync dirty tracking so the view and DB agree.
    await editorOps.applyEdit("whole", finalBody);
    notifySaved();
  }

  function submit() {
    if (!state || !instruction.trim()) return;
    const editorOps = ops.current;
    if (!editorOps) {
      toast.error("The editor isn't ready yet — try again in a moment.");
      return;
    }
    const fullBody = editorOps.getMarkdown();
    const mode = state.mode;
    const excerpt = state.excerpt;
    const trimmed = instruction.trim();

    setBusy(true);
    void (async () => {
      try {
        if (mode === "selection") {
          const { text } = await requestAgentEdit({
            contentPieceId,
            mode,
            instruction: trimmed,
            fullBody,
            excerpt,
          });
          // applyEdit resolves with the editor's authoritative body AFTER
          // Lexical commits (a synchronous read would be the pre-edit body).
          const newBody = await editorOps.applyEdit(mode, text);
          await saveDraftBody({ contentPieceId, body: newBody });
          notifySaved();
        } else {
          await runWholeEdit(editorOps, fullBody, trimmed);
        }
        toast.success("Update revised");
        reset();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Something went wrong");
      } finally {
        setBusy(false);
      }
    })();
  }

  const isWhole = state?.mode === "whole";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && reset()}>
      <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" /> Ask for changes
          </DialogTitle>
          <DialogDescription>
            {isWhole
              ? "Your instruction is applied across the whole update, then reviewed against your brand guidelines."
              : "Your instruction is applied to the highlighted text only."}
          </DialogDescription>
        </DialogHeader>

        {busy && isWhole ? (
          <ProgressChecklist steps={EDIT_STEPS} statuses={statuses} detail={detail} className="py-2" />
        ) : busy ? (
          <div className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Rewriting the selected text…
          </div>
        ) : (
          <div className="space-y-3">
            {state?.mode === "selection" && state.excerpt.trim() && (
              <blockquote className="max-h-32 overflow-auto rounded-md border bg-muted/50 p-2 text-sm whitespace-pre-wrap text-muted-foreground">
                {state.excerpt}
              </blockquote>
            )}
            <Textarea
              autoFocus
              rows={4}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g. Make this more concise and benefit-led"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
              }}
            />
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" disabled={busy} />}>Cancel</DialogClose>
          <Button onClick={submit} disabled={busy || !instruction.trim()}>
            {busy ? "Working…" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
