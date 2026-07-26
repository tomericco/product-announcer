"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveNotionDatabase } from "./notion-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function NotionDatabaseForm({
  databases,
  currentDatabaseId,
}: {
  databases: { id: string; title: string }[];
  currentDatabaseId?: string | null;
}) {
  const [databaseId, setDatabaseId] = useState(currentDatabaseId ?? databases[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  const selectedName = databases.find((d) => d.id === databaseId)?.title ?? "";

  async function handleSave(formData: FormData) {
    setSubmitting(true);
    formData.set("databaseName", selectedName);
    const result = await saveNotionDatabase(formData);
    if (result.ok) toast.success("Notion database selected");
    else toast.error(result.error);
    setSubmitting(false);
  }

  if (databases.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No databases are shared with this integration yet. In Notion, share your tasks database with the app, then reload.
      </p>
    );
  }

  return (
    <form action={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label>Tasks database</Label>
        <Select name="databaseId" value={databaseId} onValueChange={(value) => setDatabaseId(value as string)}>
          <SelectTrigger>
            <SelectValue>{selectedName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {databases.map((db) => (
              <SelectItem key={db.id} value={db.id}>
                <span className="flex items-center gap-2">
                  {db.title}
                  {db.id === currentDatabaseId && (
                    <Badge variant="secondary" className="pointer-events-none">Current</Badge>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" variant="outline" disabled={submitting}>
        {submitting ? "Saving…" : "Use this database"}
      </Button>
    </form>
  );
}
