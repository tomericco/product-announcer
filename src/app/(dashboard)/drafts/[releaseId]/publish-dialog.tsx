"use client";

import { useRef, useState, useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { DestinationId, PublishTarget } from "@/lib/publishing/destinations/types";
import { approveDraft } from "../actions";

/**
 * "Approve & publish" on the draft detail page. Opens a modal listing every
 * publish destination: configured ones as checkboxes (all pre-checked),
 * unconfigured ones as a muted row with a "Set up" link to /integrations
 * (new tab, so the in-progress draft isn't navigated away from). Publish
 * stays disabled until at least one destination is checked.
 *
 * Follows the FormData-in-JS idiom from
 * atomic-updates/new-atomic-update-dialog: the dialog content is portaled
 * outside the <form>, so rather than relying on native serialization it reads
 * the live form via a ref to the in-form trigger button
 * (`triggerRef.current.form`) — capturing the current title/body/hidden fields
 * exactly as a submit would — then appends the chosen destinations and invokes
 * approveDraft in a transition. approveDraft's redirect("/drafts") navigates
 * the router on success (a server action invoked in a transition navigates;
 * see the Next server-actions guide).
 */
export function PublishDialog({ targets }: { targets: PublishTarget[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<DestinationId>>(
    () => new Set(targets.filter((t) => t.configured).map((t) => t.id))
  );
  const [pending, startTransition] = useTransition();
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

  function publish() {
    const form = triggerRef.current?.form;
    if (!form) return;
    const formData = new FormData(form);
    for (const id of selected) formData.append("destinations", id);
    // No try/catch: approveDraft calls redirect(), which throws NEXT_REDIRECT
    // as control flow and must not be swallowed. Its empty-set guard can't be
    // reached from here — Publish is disabled until ≥1 destination is checked.
    startTransition(async () => {
      await approveDraft(formData);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button ref={triggerRef} type="button">
            Publish
          </Button>
        }
      />
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
  );
}
