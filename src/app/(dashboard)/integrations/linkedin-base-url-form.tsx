"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveLinkedinBaseUrl } from "./linkedin-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LinkedinBaseUrlForm() {
  const [submitting, setSubmitting] = useState(false);

  async function handleSave(formData: FormData) {
    setSubmitting(true);
    try {
      await saveLinkedinBaseUrl(formData);
      toast.success("Changelog base URL saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the base URL");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form action={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="baseUrl">Changelog base URL</Label>
        <p className="text-xs text-muted-foreground">
          Used to build the link back to each release from its LinkedIn post.
        </p>
        <Input id="baseUrl" name="baseUrl" type="url" placeholder="https://acme.com/changelog/" required />
      </div>
      <Button type="submit" variant="outline" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
