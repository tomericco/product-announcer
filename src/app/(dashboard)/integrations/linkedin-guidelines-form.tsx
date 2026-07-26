"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveLinkedinGuidelines } from "./linkedin-actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function LinkedinGuidelinesForm({ initialGuidelines }: { initialGuidelines: string }) {
  const [submitting, setSubmitting] = useState(false);

  async function handleSave(formData: FormData) {
    setSubmitting(true);
    try {
      await saveLinkedinGuidelines(formData);
      toast.success("LinkedIn guidelines saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the guidelines");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form action={handleSave} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="guidelines">Post guidelines (optional)</Label>
        <p className="text-xs text-muted-foreground">
          Company-specific rules for LinkedIn posts — tone, phrasing, hashtags, things to avoid. These extend the
          generation prompt for every LinkedIn post.
        </p>
        <Textarea
          id="guidelines"
          name="guidelines"
          rows={5}
          defaultValue={initialGuidelines}
          placeholder="e.g. Keep it upbeat and first-person plural. Always end with #ProductUpdate. Never mention competitors by name."
        />
      </div>
      <Button type="submit" variant="outline" disabled={submitting}>
        {submitting ? "Saving…" : "Save guidelines"}
      </Button>
    </form>
  );
}
