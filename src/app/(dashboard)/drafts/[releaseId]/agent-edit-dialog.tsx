"use client";

import { useState } from "react";
import { Sparkles, Loader2, Check, Circle } from "lucide-react";
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
import { useUnsavedChanges } from "../../unsaved-changes";
import { useAgentEdit, type EditorOps } from "./agent-edit-context";
import { requestAgentEdit, saveDraftBody } from "./actions";

type StepStatus = "pending" | "active" | "done";

function initialEditStatuses(): Record<DraftStepKey, StepStatus> {
  const statuses = {} as Record<DraftStepKey, StepStatus>;
  for (const step of EDIT_STEPS) statuses[step.key] = "pending";
  return statuses;
}

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
export function AgentEditDialog({ releaseId }: { releaseId: string }) {
  const { state, close, ops } = useAgentEdit();
  const { notifySaved } = useUnsavedChanges();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [statuses, setStatuses] = useState<Record<DraftStepKey, StepStatus>>(initialEditStatuses);
  const [detail, setDetail] = useState("");

  const open = state !== null;

  function reset() {
    setInstruction("");
    setStatuses(initialEditStatuses());
    setDetail("");
    close();
  }

  // Whole-update edit: consume the NDJSON progress stream from the pipeline
  // route, drive the step checklist, then drop the reviewed body (which the
  // route already persisted) into the editor.
  async function runWholeEdit(editorOps: EditorOps, fullBody: string, trimmed: string) {
    setStatuses(initialEditStatuses());
    setDetail("");

    const res = await fetch("/api/drafts/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ releaseId, instruction: trimmed, fullBody }),
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

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) handle(JSON.parse(line) as DraftProgressEvent);
    }
    if (buffer.trim()) handle(JSON.parse(buffer) as DraftProgressEvent);

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
            releaseId,
            mode,
            instruction: trimmed,
            fullBody,
            excerpt,
          });
          // applyEdit resolves with the editor's authoritative body AFTER
          // Lexical commits (a synchronous read would be the pre-edit body).
          const newBody = await editorOps.applyEdit(mode, text);
          await saveDraftBody({ releaseId, body: newBody });
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
          <ol className="space-y-2 py-2">
            {EDIT_STEPS.map((step) => {
              const st = statuses[step.key];
              return (
                <li key={step.key} className="flex items-center gap-2 text-sm">
                  {st === "done" ? (
                    <Check className="size-4 text-emerald-600" />
                  ) : st === "active" ? (
                    <Loader2 className="size-4 animate-spin text-foreground" />
                  ) : (
                    <Circle className="size-4 text-muted-foreground/40" />
                  )}
                  <span className={st === "pending" ? "text-muted-foreground" : "text-foreground"}>
                    {step.label}
                  </span>
                  {st === "active" && detail && (
                    <span className="text-xs text-muted-foreground">· {detail}</span>
                  )}
                </li>
              );
            })}
          </ol>
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
