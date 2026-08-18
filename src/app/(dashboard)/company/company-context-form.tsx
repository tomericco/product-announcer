"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { saveCompanyContext, bootstrapFromWebsite } from "./actions";
import { ToastForm } from "../settings/toast-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function CompanyContextForm({
  defaultWebsiteUrl,
  defaultOneLiner,
  defaultCategory,
  defaultPositioning,
  defaultTopics,
}: {
  defaultWebsiteUrl: string;
  defaultOneLiner: string;
  defaultCategory: string;
  defaultPositioning: string;
  defaultTopics: string;
}) {
  const [websiteUrl, setWebsiteUrl] = useState(defaultWebsiteUrl);
  const [drafting, setDrafting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const router = useRouter();

  // This only ever DRAFTS the fields below -- the human reviews and corrects
  // before Save. But bootstrapCompanyContext's merge is one-directional: a
  // null derivation never clears an existing value, but a *successful* one
  // for one-liner/category/positioning/topics replaces whatever is already
  // there, including hand-written edits (see the comment on that merge in
  // company-bootstrap.ts). Re-running this from settings against an
  // already-edited profile is exactly that case, so it confirms first --
  // same interaction as importBrandStyleFromUrl next door.
  function requestDraft() {
    if (!websiteUrl.trim() || drafting) return;
    setConfirmOpen(true);
  }

  async function draft() {
    setConfirmOpen(false);
    const trimmed = websiteUrl.trim();
    if (!trimmed || drafting) return;
    setDrafting(true);
    try {
      const result = await bootstrapFromWebsite(trimmed);
      if (result.ok) {
        toast.success("Drafted from your website — review and correct before it's used.");
        router.refresh();
      } else {
        toast.error("Couldn't read that site — check the URL and try again.");
      }
    } finally {
      setDrafting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="companyWebsiteUrl">Website</Label>
        <div className="flex gap-2">
          <Input
            id="companyWebsiteUrl"
            type="url"
            placeholder="https://yourproduct.com"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
            className="flex-1"
          />
          <Button type="button" variant="outline" onClick={requestDraft} disabled={drafting || !websiteUrl.trim()}>
            {drafting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {drafting ? "Drafting…" : "Draft from my website"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          This drafts the fields below from your own site&apos;s copy — a starting point, not a final answer. Nothing
          below is used until you review it and hit Save.
        </p>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Replace your company context?</DialogTitle>
            <DialogDescription>
              This replaces your one-liner, market category, positioning, and topics with what we derive from the
              site — including anything you&apos;ve written or edited by hand. Competitors are only added to, never
              removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={draft}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ToastForm action={saveCompanyContext} successMessage="Company context saved" className="space-y-4">
        {/* The visible Website input above is deliberately outside this form
            (it also drives the draft button), so without this hidden field
            Save would never submit it -- correcting a stale URL by hand would
            silently revert on the next render even though Save reported
            success. Mirrors the `websiteUrl` state already tracked above. */}
        <input type="hidden" name="websiteUrl" value={websiteUrl} />
        <div className="space-y-2">
          <Label htmlFor="oneLiner">One-liner</Label>
          <Input
            id="oneLiner"
            name="oneLiner"
            defaultValue={defaultOneLiner}
            placeholder="Issue tracking for software teams."
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="category">Market category</Label>
          <Input
            id="category"
            name="category"
            defaultValue={defaultCategory}
            placeholder="Project management software"
          />
          <p className="text-xs text-muted-foreground">
            Prose describing your market. Used later to score how relevant incoming signals are — not the same as
            Industry below, which selects writing exemplars.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="positioning">Positioning</Label>
          <Textarea
            id="positioning"
            name="positioning"
            rows={3}
            defaultValue={defaultPositioning}
            placeholder="Differentiators and the messages you want to own."
          />
          <p className="text-xs text-muted-foreground">
            The yardstick every incoming signal is scored against, not just a setting.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="topics">Topics</Label>
          <Textarea
            id="topics"
            name="topics"
            rows={3}
            defaultValue={defaultTopics}
            placeholder={"ai agents, developer tools\nobservability"}
          />
          <p className="text-xs text-muted-foreground">
            Comma- or newline-separated. The subjects in your lane — drives what the news agent watches for.
          </p>
        </div>
        <Button type="submit" variant="outline">
          Save
        </Button>
      </ToastForm>
    </div>
  );
}
