"use client";

import { useRef, useState, useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { InvalidLinksDialog } from "../invalid-links-dialog";
import type { LinkProblem } from "@/lib/ai/validate-links";
import { useAgentEdit } from "./agent-edit-context";
import { saveDraftBody } from "./actions";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DestinationId, PublishTarget } from "@/lib/publishing/destinations/types";
import { approveDraft, checkDraftLinks } from "../actions";

/**
 * "Approve & publish" on the draft detail page. Opens a modal listing every
 * publish destination: configured ones as checkboxes (all pre-checked),
 * unconfigured ones as a muted row with a "Set up" link to /integrations
 * (new tab, so the in-progress draft isn't navigated away from). Publish
 * stays disabled until at least one destination is checked.
 *
 * Clicking Publish first runs the invalid-link check (`checkDraftLinks`) against
 * the live body; if the body has bad links it opens the error modal and the
 * destination chooser never appears. Only a clean body opens the chooser.
 *
 * Follows the FormData-in-JS idiom from
 * atomic-updates/new-atomic-update-dialog: the dialog content is portaled
 * outside the <form>, so rather than relying on native serialization it reads
 * the live form via a ref to the in-form Publish button
 * (`triggerRef.current.form`) — capturing the current title/body/hidden fields
 * exactly as a submit would — then appends the chosen destinations and invokes
 * approveDraft in a transition. approveDraft's redirect("/board") navigates
 * the router on success (a server action invoked in a transition navigates;
 * see the Next server-actions guide).
 */
export function PublishDialog({ contentPieceId, targets }: { contentPieceId: string; targets: PublishTarget[] }) {
  const { ops } = useAgentEdit();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<DestinationId>>(
    () => new Set(targets.filter((t) => t.configured).map((t) => t.id))
  );
  const [pending, startTransition] = useTransition();
  // Non-null while the error modal is open: the body being fixed + its problems.
  const [fixTarget, setFixTarget] = useState<{ body: string; problems: LinkProblem[] } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const configured = targets.filter((t) => t.configured);
  const unconfigured = targets.filter((t) => !t.configured);

  function toggle(id: DestinationId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Publish (the button that opens the chooser): check links first, and open the
  // destination chooser only if the body is clean — otherwise show the errors.
  function openChooser() {
    const form = triggerRef.current?.form;
    if (!form) return;
    const formData = new FormData(form);
    const body = String(formData.get("body") ?? "");
    startTransition(async () => {
      const { problems } = await checkDraftLinks(formData);
      if (problems.length) setFixTarget({ body, problems });
      else setOpen(true);
    });
  }

  function publish() {
    const form = triggerRef.current?.form;
    if (!form) return;
    const formData = new FormData(form);
    const body = String(formData.get("body") ?? "");
    for (const id of selected) formData.append("destinations", id);
    // No try/catch: on success approveDraft calls redirect(), which throws
    // NEXT_REDIRECT as control flow and must not be swallowed. It re-checks
    // links as a backstop and, if the body has bad links, RETURNS them (no
    // redirect) — surface those in the error modal and close this dialog.
    startTransition(async () => {
      const result = await approveDraft(formData);
      if (result?.problems.length) {
        setOpen(false);
        setFixTarget({ body, problems: result.problems });
      }
    });
  }

  // Save inline link fixes: apply the patched body to the live editor (so the
  // visible content and the hidden body field update together), then persist it.
  async function saveFixes(patchedBody: string) {
    const authoritative = ops.current ? await ops.current.applyEdit("whole", patchedBody) : patchedBody;
    await saveDraftBody({ contentPieceId, body: authoritative });
    setFixTarget(null);
    toast.success("Links updated — you can publish now.");
  }

  return (
    <>
    <Button ref={triggerRef} type="button" onClick={openChooser} disabled={pending}>
      {pending ? "Checking…" : "Publish"}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-5 p-6 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Publish release</DialogTitle>
          <DialogDescription>
            Choose where to publish. Publishing marks this release published and delivers it to the
            selected destinations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {configured.map((t) => (
            <label key={t.id} className="flex cursor-pointer items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="size-4 rounded border-input"
                checked={selected.has(t.id)}
                onChange={() => toggle(t.id)}
              />
              <span className="font-medium">{t.label}</span>
            </label>
          ))}

          {unconfigured.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between gap-3 text-sm text-muted-foreground"
            >
              <span>{t.label}</span>
              <a
                href="/integrations"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
              >
                Set up
                <ExternalLink className="size-3" />
              </a>
            </div>
          ))}

          {targets.length === 0 && (
            <p className="text-sm text-muted-foreground">No publish destinations available.</p>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button type="button" onClick={publish} disabled={selected.size === 0 || pending}>
            {pending ? "Publishing…" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <InvalidLinksDialog
      target={fixTarget}
      onSave={saveFixes}
      onOpenChange={(next) => !next && setFixTarget(null)}
    />
    </>
  );
}
