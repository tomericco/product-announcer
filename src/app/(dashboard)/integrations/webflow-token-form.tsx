"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveWebflowToken } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function WebflowTokenForm() {
  const [submitting, setSubmitting] = useState(false);

  async function handleSave(formData: FormData) {
    setSubmitting(true);
    try {
      await saveWebflowToken(formData);
      toast.success("Webflow token saved");
    } catch (error) {
      // saveWebflowToken validates the token with a live listSites call before
      // storing anything, so a bad token surfaces here rather than blowing up
      // the whole page with an unstyled error boundary.
      toast.error(error instanceof Error ? error.message : "Could not connect to Webflow");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form action={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="token">Site API token</Label>
        <p className="text-xs text-muted-foreground">
          Generate one from your Webflow site&apos;s Apps &amp; Integrations settings.
        </p>
        {/* Write-only: never rendered back with a defaultValue, same as the
            webhook secret field on this page. */}
        <Input id="token" type="password" name="token" autoComplete="off" required />
      </div>
      <Button type="submit" variant="outline" disabled={submitting}>
        {submitting ? "Connecting…" : "Connect Webflow"}
      </Button>
    </form>
  );
}
