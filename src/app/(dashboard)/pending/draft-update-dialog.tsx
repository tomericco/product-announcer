"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { Loader2, Check, Circle, AlertCircle } from "lucide-react";
import { DRAFT_STEPS, type DraftProgressEvent, type DraftStepKey } from "@/lib/scheduling/draft-progress";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type Phase = "preview" | "progress" | "error" | "success";
type StepStatus = "pending" | "active" | "done";

export function DraftUpdateDialog({
  preview,
}: {
  preview: { count: number; earliest: string | null; latest: string | null };
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("preview");
  const [statuses, setStatuses] = useState<Record<DraftStepKey, StepStatus>>(initialStatuses());
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  const [updateId, setUpdateId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("preview");
    setStatuses(initialStatuses());
    setDetail("");
    setError("");
    setUpdateId(null);
  }

  function apply(event: DraftProgressEvent) {
    if (event.type === "step") {
      setStatuses((s) => ({ ...s, [event.key]: event.status === "start" ? "active" : "done" }));
      if (event.status === "start") setDetail("");
    } else if (event.type === "detail") {
      setDetail(event.text);
    } else if (event.type === "done") {
      setUpdateId(event.updateId);
      setPhase("success");
    } else if (event.type === "error") {
      setError(event.message);
      setPhase("error");
    }
  }

  async function create() {
    reset();
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase("progress");
    try {
      const res = await fetch("/api/pending/draft", { method: "POST", signal: ac.signal });
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
          if (line.trim() && !ac.signal.aborted) apply(JSON.parse(line) as DraftProgressEvent);
        }
      }
      if (buffer.trim() && !ac.signal.aborted) apply(JSON.parse(buffer) as DraftProgressEvent);
    } catch (e) {
      if (ac.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }

  const range =
    preview.earliest && preview.latest
      ? `${fmt(preview.earliest)} → ${fmt(preview.latest)}`
      : "no dated changes";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button>Draft update now</Button>} />
      <DialogContent className="flex flex-col gap-5 p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Draft update</DialogTitle>
        </DialogHeader>

        {phase === "preview" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This draft will include <span className="font-medium text-foreground">{preview.count}</span>{" "}
              change{preview.count === 1 ? "" : "s"} ({range}).
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={create} disabled={preview.count === 0}>Create draft</Button>
            </div>
          </div>
        )}

        {phase === "progress" && (
          <ol className="space-y-2">
            {DRAFT_STEPS.map((step) => {
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
              {updateId && <Button render={<Link href={`/drafts/${updateId}`} />}>Review it</Button>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function initialStatuses(): Record<DraftStepKey, StepStatus> {
  return DRAFT_STEPS.reduce(
    (acc, s) => ({ ...acc, [s.key]: "pending" }),
    {} as Record<DraftStepKey, StepStatus>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString();
}
