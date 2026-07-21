"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveWebhookConfig } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Extracted out of page.tsx (a Server Component, which can't hold this
// submitting-state/toast logic itself) so a save failure — e.g. a URL that
// fails validation — renders the actual message. saveWebhookConfig returns a
// result object rather than throwing, since a thrown server-action error's
// message is stripped in a production build before it reaches the client.
export function WebhookConfigForm({ config }: { config: { url: string; active: boolean } | null }) {
  const [submitting, setSubmitting] = useState(false);

  async function handleSave(formData: FormData) {
    setSubmitting(true);
    const result = await saveWebhookConfig(formData);
    if (result.ok) {
      toast.success("Webhook configuration saved");
    } else {
      toast.error(result.error);
    }
    setSubmitting(false);
  }

  return (
    <form action={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="url">URL</Label>
        <Input id="url" type="url" name="url" defaultValue={config?.url ?? ""} required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="secret">Secret</Label>
        <Input
          id="secret"
          type="password"
          name="secret"
          placeholder={config ? "Saved — leave blank to keep" : ""}
          required={!config}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="active"
          defaultChecked={config?.active ?? true}
          className="size-4 rounded border-input"
        />
        Active
      </label>
      <Button type="submit" variant="outline" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
