"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { Check, AlertCircle } from "lucide-react";
import { DRAFT_STEPS, type DraftProgressEvent, type DraftStepKey } from "@/lib/scheduling/draft-progress";
import {
  ProgressChecklist,
  initialStepStatuses,
  type StepStatus,
} from "@/components/draft-progress-checklist";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type Phase = "preview" | "progress" | "error" | "success";

// Minimum time a step stays visible before the next transition, so a fast
// backend doesn't flicker the steps past. It's a floor, not a fixed delay —
// steps whose real work already took longer are not padded.
const MIN_STEP_MS = 1000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export function DraftReleaseDialog({ atomicUpdateIds }: { atomicUpdateIds: string[] }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("preview");
  const [statuses, setStatuses] = useState<Record<DraftStepKey, StepStatus>>(() =>
    initialStepStatuses(DRAFT_STEPS)
  );
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  const [contentPieceId, setContentPieceId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastTransitionRef = useRef(0);
  // Set by the Abort button so its programmatic close is allowed through the
  // "non-dismissible while generating" guard in onOpenChange below.
  const closingRef = useRef(false);

  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("preview");
    setStatuses(initialStepStatuses(DRAFT_STEPS));
    setDetail("");
    setError("");
    setContentPieceId(null);
  }

  function apply(event: DraftProgressEvent) {
    if (event.type === "step") {
      setStatuses((s) => ({ ...s, [event.key]: event.status === "start" ? "active" : "done" }));
      if (event.status === "start") setDetail("");
    } else if (event.type === "detail") {
      setDetail(event.text);
    } else if (event.type === "done") {
      setContentPieceId(event.updateId);
      setPhase("success");
    } else if (event.type === "error") {
      setError(event.message);
      setPhase("error");
    }
  }

  // Applies an event, but keeps each step on screen for at least MIN_STEP_MS.
  // A step becoming active renders immediately and anchors the clock; a step
  // finishing (and the terminal done/error) waits out the remainder of the
  // minimum so the transition doesn't flicker. Detail refinements update live.
  async function pacedApply(event: DraftProgressEvent, ac: AbortController) {
    if (event.type === "detail") {
      apply(event);
      return;
    }
    if (event.type === "step" && event.status === "start") {
      apply(event);
      lastTransitionRef.current = Date.now();
      return;
    }
    const wait = MIN_STEP_MS - (Date.now() - lastTransitionRef.current);
    if (wait > 0) await sleep(wait, ac.signal);
    if (ac.signal.aborted) return;
    apply(event);
    lastTransitionRef.current = Date.now();
  }

  async function create() {
    reset();
    const ac = new AbortController();
    abortRef.current = ac;
    lastTransitionRef.current = Date.now();
    setPhase("progress");
    try {
      const res = await fetch("/api/atomic-updates/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ atomicUpdateIds }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        if (!ac.signal.aborted) {
          setError(res.status === 401 ? "Your session expired — please sign in again." : "Failed to start draft creation.");
          setPhase("error");
        }
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        if (ac.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() && !ac.signal.aborted) await pacedApply(JSON.parse(line) as DraftProgressEvent, ac);
        }
      }
      if (buffer.trim() && !ac.signal.aborted) await pacedApply(JSON.parse(buffer) as DraftProgressEvent, ac);
    } catch (e) {
      if (ac.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }

  // Aborts the in-flight generation and closes the modal. The onOpenChange
  // guard blocks overlay/Esc dismissal while generating, so this routes the
  // close through closingRef to get past it.
  function abort() {
    closingRef.current = true;
    reset();
    setOpen(false);
  }

  const count = atomicUpdateIds.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // While a draft is generating the modal is non-dismissible: swallow
        // overlay-click / Esc close requests. Abort is the only way out.
        if (!next && phase === "progress" && !closingRef.current) return;
        closingRef.current = false;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button disabled={count === 0}>Draft release ({count})</Button>} />
      {/* No close (X) button while generating — Abort is the deliberate exit. */}
      <DialogContent showCloseButton={phase !== "progress"} className="flex flex-col gap-5 p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Draft release</DialogTitle>
        </DialogHeader>

        {phase === "preview" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This release will include <span className="font-medium text-foreground">{count}</span>{" "}
              atomic update{count === 1 ? "" : "s"}.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={create} disabled={count === 0}>Create draft</Button>
            </div>
          </div>
        )}

        {phase === "progress" && (
          <div className="space-y-5">
            <ProgressChecklist steps={DRAFT_STEPS} statuses={statuses} detail={detail} />
            <div className="flex justify-end">
              <Button variant="outline" onClick={abort}>
                Abort
              </Button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p className="break-words text-destructive">{error}</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
              <Button onClick={create}>Try again</Button>
            </div>
          </div>
        )}

        {phase === "success" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-emerald-600">
              <Check className="size-4" /> Draft created.
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
              {contentPieceId && <Button render={<Link href={`/drafts/${contentPieceId}`} />}>Review it</Button>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
