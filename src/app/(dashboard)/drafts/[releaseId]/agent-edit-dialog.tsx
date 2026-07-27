"use client";

import { useState, useTransition } from "react";
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
import { useUnsavedChanges } from "../../unsaved-changes";
import { useAgentEdit } from "./agent-edit-context";
import { requestAgentEdit, saveDraftBody } from "./actions";

/**
 * Shared "Ask AI" modal for both entry points. Reads the live editor body,
 * asks the agent, applies the result (surgical splice for selection mode, full
 * replace for whole mode), persists the committed body, and re-syncs dirty
 * tracking — all behind a compose-style spinner. Rendered once at page level;
 * open state and mode come from the agent-edit context.
 */
export function AgentEditDialog({ releaseId }: { releaseId: string }) {
  const { state, close, ops } = useAgentEdit();
  const { notifySaved } = useUnsavedChanges();
  const [instruction, setInstruction] = useState("");
  const [isPending, startTransition] = useTransition();

  const open = state !== null;

  function reset() {
    setInstruction("");
    close();
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

    startTransition(async () => {
      try {
        const { text } = await requestAgentEdit({
          releaseId,
          mode,
          instruction: instruction.trim(),
          fullBody,
          excerpt: mode === "selection" ? excerpt : undefined,
        });

        // applyEdit resolves with the editor's authoritative body AFTER
        // Lexical commits the change — reading getMarkdown() synchronously
        // would persist the pre-edit body (the commit is deferred to a
        // microtask). Persist that true new body, then re-sync dirty tracking
        // so the body section is clean and re-baselined to what was saved.
        const newBody = await editorOps.applyEdit(mode, text);
        await saveDraftBody({ releaseId, body: newBody });
        notifySaved();

        toast.success("Update revised");
        reset();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Something went wrong");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !isPending && reset()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" /> Ask AI to edit
          </DialogTitle>
          <DialogDescription>
            {state?.mode === "selection"
              ? "Your instruction is applied to the highlighted text only."
              : "Your instruction is applied across the whole update."}
          </DialogDescription>
        </DialogHeader>

        {isPending ? (
          <div className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Rewriting your update…
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
          <DialogClose render={<Button variant="ghost" disabled={isPending} />}>Cancel</DialogClose>
          <Button onClick={submit} disabled={isPending || !instruction.trim()}>
            {isPending ? "Rewriting…" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
