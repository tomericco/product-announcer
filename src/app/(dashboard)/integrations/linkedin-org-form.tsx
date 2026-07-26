"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveLinkedinOrganization } from "./linkedin-actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function LinkedinOrgForm({ orgs }: { orgs: { urn: string; name: string }[] }) {
  const [urn, setUrn] = useState(orgs[0]?.urn ?? "");
  const [submitting, setSubmitting] = useState(false);
  const selectedName = orgs.find((o) => o.urn === urn)?.name ?? "";

  async function handleSave(formData: FormData) {
    // The select only carries the urn; resolve and attach the paired name
    // here so saveLinkedinOrganization's action gets both unambiguously.
    formData.set("name", selectedName);
    setSubmitting(true);
    try {
      await saveLinkedinOrganization(formData);
      toast.success("LinkedIn company page selected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the company page");
    } finally {
      setSubmitting(false);
    }
  }

  if (orgs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No company pages you administer were found. You need admin access to a LinkedIn company page to
        continue.
      </p>
    );
  }

  return (
    <form action={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label>Company page</Label>
        <Select name="urn" value={urn} onValueChange={(value) => setUrn(value as string)}>
          <SelectTrigger>
            <SelectValue>{selectedName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {orgs.map((org) => (
              <SelectItem key={org.urn} value={org.urn}>
                {org.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" variant="outline" disabled={submitting}>
        {submitting ? "Saving…" : "Use this page"}
      </Button>
    </form>
  );
}
