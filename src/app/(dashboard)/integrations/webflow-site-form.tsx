"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveWebflowSite } from "./actions";
import type { WebflowSite } from "@/lib/integrations/webflow/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function WebflowSiteForm({
  sites,
  currentSiteId,
}: {
  sites: WebflowSite[];
  // Undefined during first-time setup (no site chosen yet) — the picker then
  // has nothing to default to and falls back to the first entry. When this
  // component is reused from "Change site" on an already-connected tenant,
  // it must open pre-selected on what is actually wired up, not on whatever
  // happens to sort first — confirming the wrong pre-selection silently
  // wipes the collection and its field mapping.
  currentSiteId?: string | null;
}) {
  const [siteId, setSiteId] = useState(currentSiteId ?? sites[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);

  const selectedName = sites.find((s) => s.id === siteId)?.displayName ?? "";

  async function handleSave(formData: FormData) {
    setSubmitting(true);
    try {
      // The Select only posts siteId; the display name is looked up here
      // rather than trusted from a second (spoofable) form field.
      formData.set("siteName", selectedName);
      await saveWebflowSite(formData);
      toast.success("Webflow site selected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the selected site");
    } finally {
      setSubmitting(false);
    }
  }

  if (sites.length === 0) {
    return <p className="text-sm text-muted-foreground">No sites found on this Webflow account.</p>;
  }

  return (
    <form action={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label>Site</Label>
        {/* shadcn/Base UI Select does not post a value like a native
            <select name>, so this is controlled and paired with `name` —
            same mechanism as the cadence Select in settings/schedule-form.tsx. */}
        <Select name="siteId" value={siteId} onValueChange={(value) => setSiteId(value as string)}>
          <SelectTrigger>
            <SelectValue>{selectedName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {sites.map((site) => (
              <SelectItem key={site.id} value={site.id}>
                <span className="flex items-center gap-2">
                  {site.displayName}
                  {site.id === currentSiteId && (
                    <Badge variant="secondary" className="pointer-events-none">
                      Current
                    </Badge>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" variant="outline" disabled={submitting}>
        {submitting ? "Saving…" : "Use this site"}
      </Button>
    </form>
  );
}
